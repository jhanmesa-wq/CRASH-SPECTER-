import*as acorn from'acorn'
import*as walk from'acorn-walk'
import*as babel from'@babel/parser'
import protobuf from'protobufjs'
import{fetch}from'undici'
import{mkdir,writeFile}from'fs/promises'
import{join}from'path'

const OUT='/storage/emulated/0/WhatsApp/proto-results'
const BASE='https://web.whatsapp.com'
const HEADERS={
 'User-Agent':'Mozilla/5.0 (X11; Linux x86_64; rv:100.0) Gecko/20100101 Firefox/100.0',
 'Sec-Fetch-Dest':'script',
 'Sec-Fetch-Mode':'no-cors',
 'Sec-Fetch-Site':'same-origin',
 Referer:`${BASE}/`,
 Accept:'*/*',
 'Accept-Language':'en-US,en;q=0.5'
}

let whatsAppVersion='latest'

const addPrefix=(lines,prefix)=>lines.map(line=>prefix+line)

const extractAllExpressions=node=>{
 const expressions=[node]
 const exp=node?.expression

 if(exp)expressions.push(exp)

 if(exp?.arguments?.length){
  for(const arg of exp.arguments){
   if(arg?.body?.body?.length){
    for(const x of arg.body.body)expressions.push(...extractAllExpressions(x))
   }
  }
 }

 if(node?.body?.body?.length){
  for(const x of node.body.body){
   if(x.expression)expressions.push(...extractAllExpressions(x.expression))
  }
 }

 if(exp?.expressions?.length){
  for(const x of exp.expressions)expressions.push(...extractAllExpressions(x))
 }

 return expressions
}

const get=async url=>{
 const r=await fetch(url,{headers:HEADERS})
 if(!r.ok)throw new Error(`${r.status} ${r.statusText}: ${url}`)
 return await r.text()
}

const parseSource=src=>{
 try{
  return{
   ast:acorn.parse(src,{
    ecmaVersion:'latest',
    sourceType:'script',
    allowHashBang:true
   }),
   parser:'acorn'
  }
 }catch{
  return{
   ast:babel.parse(src,{
    sourceType:'unambiguous',
    plugins:[
     'jsx',
     'classProperties',
     'optionalChaining',
     'nullishCoalescingOperator'
    ]
   }),
   parser:'babel'
  }
 }
}

const CHUNK_PATTERNS=[
 /importScripts\(\s*["']([^"']+)["']\s*\)/g,
 /["'](https?:\/\/static\.whatsapp\.net\/rsrc\.php\/[^"']+\.js)["']/g,
 /["'](\/rsrc\.php\/[^"']+\.js)["']/g,
 /\bwebpackJsonp\w*\.push\(\[\s*\[([^\]]+)\]/g
]

const findChunkUrls=text=>{
 const clear=text.replaceAll('/*BTDS*/','')
 const urls=new Set

 for(const re of CHUNK_PATTERNS){
  re.lastIndex=0

  let m
  while((m=re.exec(clear))){
   const value=m[1]

   if(!value||/^\d+(,\d+)*$/.test(value))continue

   try{
    urls.add(new URL(value.replaceAll('\\',''),BASE).href)
   }catch{}
  }
 }

 return[...urls]
}

async function discoverAllSources(){
 const sw=await get(`${BASE}/sw.js`)
 await writeFile(join(OUT,'sw.js'),sw)

 const patterns=[
  /client_revision\\":([\d.]+),/g,
  /\\"?client_revision\\?":\s*(\d+)/g,
  /client_revision[^0-9]{0,100}(\d+)/g
 ]

 let version

 for(const re of patterns){
  const m=re.exec(sw)

  if(m){
   version=m[1]
   break
  }
 }

 if(!version){
  throw new Error(`WhatsApp revision not found; sw.js length=${sw.length}`)
 }

 whatsAppVersion=`2.3000.${version}`
 console.log('Current version:',whatsAppVersion)

 let mainHtml=''

 try{
  mainHtml=await get(`${BASE}/`)
 }catch{}

 const seed=new Set([
  ...findChunkUrls(sw),
  ...findChunkUrls(mainHtml)
 ])

 await writeFile(
  join(OUT,'bootstrap-candidates.json'),
  JSON.stringify([...seed],null,2)
 )

 const visited=new Set()
 const sources=[]
 const queue=[...seed]

 while(queue.length){
  const url=queue.shift()

  if(visited.has(url))continue
  visited.add(url)

  let text

  try{
   text=await get(url)
  }catch{
   continue
  }

  if(text.length<200)continue

  sources.push({url,text})

  for(const next of findChunkUrls(text)){
   if(!visited.has(next)&&!queue.includes(next))queue.push(next)
  }

  if(visited.size>60)break
 }

 return sources
}

async function findAppModules(sources){
 const allModules=[]

 for(const{url,text}of sources){
  const patched=text.replaceAll(
   'LimitSharing$Trigger',
   'LimitSharing$TriggerType'
  )

  let ast
  let parser

  try{
   ({ast,parser}=parseSource(patched))
  }catch{
   continue
  }

  const body=ast.body||ast.program?.body||[]

  const result=body.filter(module=>
   extractAllExpressions(module).find(
    expression=>expression?.left?.property?.name==='internalSpec'
   )
  )

  if(result.length){
   await writeFile(
    join(OUT,`bootstrap-parser-${allModules.length}.txt`),
    `${parser}\n${url}\n${result.length} modules`
   )

   allModules.push(...result)
  }
 }

 return allModules
}

;(async()=>{
 await mkdir(OUT,{recursive:true})

 console.log('[PROTO] Loading WhatsApp Web')

 const sources=await discoverAllSources()

 await writeFile(
  join(OUT,'sources.json'),
  JSON.stringify(
   sources.map(source=>({
    url:source.url,
    size:source.text.length
   })),
   null,
   2
  )
 )

 console.log(`[PROTO] Sources fetched: ${sources.length}`)

 const unspecName=name=>
  name.endsWith('Spec')?name.slice(0,-4):name

 const unnestName=name=>
  name.split('$').slice(-1)[0]

 const getNesting=name=>
  name.split('$').slice(0,-1).join('$')

 const makeRenameFunc=()=>name=>
  unspecName(name)

 const modules=await findAppModules(sources)

 console.log(`[PROTO] Total modules found: ${modules.length}`)

 const modulesInfo={}
 const moduleIndentationMap={}
 const usesRequired={value:false}

 modules.forEach(module=>{
  const moduleName=module?.expression?.arguments?.[0]?.value

  if(!moduleName||modulesInfo[moduleName])return

  modulesInfo[moduleName]={crossRefs:[]}

  walk.simple(module,{
   AssignmentExpression(node){
    if(
     node?.right?.type==='CallExpression'&&
     node.right.arguments?.length===1&&
     node.right.arguments[0].type!=='ObjectExpression'
    ){
     modulesInfo[moduleName].crossRefs.push({
      alias:node.left?.name,
      module:node.right.arguments[0]?.value
     })
    }
   }
  })
 })

 for(const mod of modules){
  const moduleName=mod?.expression?.arguments?.[0]?.value

  if(
   !moduleName||
   !modulesInfo[moduleName]||
   modulesInfo[moduleName].identifiers
  )continue

  const modInfo=modulesInfo[moduleName]
  const rename=makeRenameFunc()
  const assignments=[]

  walk.simple(mod,{
   AssignmentExpression(node){
    const left=node.left

    if(
     left?.property?.name&&
     left.property.name!=='internalSpec'&&
     left.property.name!=='internalDefaults'&&
     left.property.name!=='name'
    ){
     assignments.push(left)
    }
   }
  })

  const makeBlankIdent=a=>{
   const key=rename(a?.property?.name)
   const indentation=getNesting(key)
   const value={name:key}

   moduleIndentationMap[key]??={}
   moduleIndentationMap[key].indentation=indentation

   if(indentation.length){
    moduleIndentationMap[indentation]??={}
    moduleIndentationMap[indentation].members??=new Set
    moduleIndentationMap[indentation].members.add(key)
   }

   return[key,value]
  }

  modInfo.identifiers=Object.fromEntries(
   assignments.map(makeBlankIdent).reverse()
  )

  const enumAliases={}

  walk.ancestor(mod,{
   Property(node,anc){
    const fatherNode=anc[anc.length-3]
    const fatherFather=anc[anc.length-4]

    if(
     fatherNode?.type==='AssignmentExpression'&&
     fatherNode.left?.property?.name==='internalSpec'&&
     fatherNode.right?.properties?.length
    ){
     const values=fatherNode.right.properties.map(p=>({
      name:p.key?.name??p.key?.value,
      id:p.value?.value
     }))

     enumAliases[fatherNode.left?.name]=values
    }else if(
     node?.key?.name&&
     fatherNode?.arguments?.length>0
    ){
     const values=fatherNode.arguments[0]?.properties?.map(p=>({
      name:p.key?.name??p.key?.value,
      id:p.value?.value
     }))||[]

     const nameAlias=
      fatherFather?.left?.name||
      fatherFather?.id?.name

     if(nameAlias&&values.length){
      enumAliases[nameAlias]=values
     }
    }
   }
  })

  walk.simple(mod,{
   AssignmentExpression(node){
    const propertyName=node.left?.property?.name

    if(
     node.left?.type==='MemberExpression'&&
     propertyName&&
     modInfo.identifiers?.[rename(propertyName)]
    ){
     const ident=modInfo.identifiers[rename(propertyName)]

     ident.alias=node.right?.name
     ident.enumValues=enumAliases[ident.alias]
    }
   }
  })
 }

 for(const mod of modules){
  const moduleName=mod?.expression?.arguments?.[0]?.value
  const modInfo=modulesInfo[moduleName]

  if(!modInfo||modInfo.processed)continue

  modInfo.processed=true

  const rename=makeRenameFunc()

  const findByAliasInIdentifier=(obj,alias)=>
   Object.values(obj).find(item=>item.alias===alias)

  walk.simple(mod,{
   AssignmentExpression(node){
    if(
     node.left?.type==='MemberExpression'&&
     node.left.property?.name==='internalSpec'&&
     node.right?.type==='ObjectExpression'
    ){
     const targetIdent=Object.values(modInfo.identifiers).find(
      value=>value.alias===node.left.object?.name
     )

     if(!targetIdent)return

     const constraints=[]
     const members=[]

     for(const p of node.right.properties){
      p.key.name=
       p.key.type==='Identifier'
        ?p.key.name
        :p.key.value

      if((p.key.name||'').startsWith('__')){
       constraints.push(p)
      }else{
       members.push(p)
      }
     }

     targetIdent.members=members.map(({
      key:{name},
      value:{elements}
     })=>{
      let type

      const flags=[]

      const unwrap=n=>
       n?.type==='BinaryExpression'&&n.operator==='|'
        ?[
          ...unwrap(n.left),
          ...unwrap(n.right)
         ]
        :[n]

      for(const m of unwrap(elements?.[1])){
       if(
        m?.type==='MemberExpression'&&
        m.object?.type==='MemberExpression'
       ){
        if(m.object.property?.name==='TYPES'){
         type=m.property?.name?.toLowerCase()

         if(type==='map'){
          let t='map<'
          const mapElements=elements?.[2]?.elements||[]

          for(const[i,e]of mapElements.entries()){
           if(e?.property?.name){
            t+=e.property.name.toLowerCase()
           }else{
            const ref=findByAliasInIdentifier(
             modInfo.identifiers,
             e?.name
            )

            t+=ref?.name||e?.name||'unknown'
           }

           if(i<mapElements.length-1)t+=', '
          }

          type=`${t}>`
         }
        }else if(m.object.property?.name==='FLAGS'){
         flags.push(m.property?.name?.toLowerCase())
        }
       }
      }

      if(flags.includes('required')){
       usesRequired.value=true
      }

      if(type==='message'||type==='enum'){
       if(elements?.[2]?.type==='Identifier'){
        type=Object.values(modInfo.identifiers).find(
         value=>value.alias===elements[2].name
        )?.name
       }else if(elements?.[2]?.type==='MemberExpression'){
        const e=elements[2]

        const crossRef=modInfo.crossRefs.find(
         ref=>
          ref.alias===e.object?.name||
          ref.alias===e.object?.left?.name||
          ref.alias===e.object?.callee?.name
        )

        if(
         elements[1]?.property?.name==='ENUM'&&
         e.property?.name?.includes('Type')
        ){
         type=rename(e.property.name)
        }else if(e.property?.name?.includes('Spec')){
         type=rename(e.property.name)
        }else if(
         crossRef&&
         crossRef.module!=='$InternalEnum'&&
         modulesInfo[crossRef.module]?.identifiers?.[
          rename(e.property?.name)
         ]
        ){
         type=rename(e.property.name)
        }
       }
      }

      return{
       name,
       id:elements?.[0]?.value,
       type,
       flags
      }
     })

     for(const c of constraints){
      if(
       c.key.name==='__oneofs__'&&
       c.value.type==='ObjectExpression'
      ){
       const oneofs=c.value.properties.map(p=>({
        name:p.key.name,
        type:'__oneof__',
        members:p.value.elements.map(e=>{
         const i=targetIdent.members.findIndex(
          m=>m.name===e.value
         )

         if(i<0)return null

         const member=targetIdent.members[i]
         targetIdent.members.splice(i,1)

         return member
        }).filter(Boolean)
       }))

       targetIdent.members.push(...oneofs)
      }
     }
    }
   }
  })
 }

 const decodedProtoMap={}
 const space='    '

 for(const mod of modules){
  const moduleName=mod?.expression?.arguments?.[0]?.value
  const modInfo=modulesInfo[moduleName]

  const identifiers=Object.values(
   modInfo?.identifiers||{}
  )

  const stringifyEnum=(ident,overrideName=null)=>[
   `enum ${overrideName||ident.displayName||ident.name} {`,
   ...addPrefix(
    (ident.enumValues||[]).map(
     value=>`${value.name} = ${value.id};`
    ),
    space
   ),
   '}'
  ]

  const stringifyMember=(info,complete,parent)=>{
   if(info.type==='__oneof__'){
    return[
     `oneof ${info.name} {`,
     ...addPrefix(
      [].concat(
       ...info.members.map(
        member=>stringifyMember(member,false)
       )
      ),
      space
     ),
     '}'
    ]
   }

   if(!info.type){
    return[
     `// Unknown field ${info.name} = ${info.id};`
    ]
   }

   if(info.flags.includes('packed')){
    info.flags.splice(
     info.flags.indexOf('packed'),
     1
    )

    info.packed=' [packed=true]'
   }

   if(
    complete&&
    info.flags.length===0&&
    !info.type.includes('map')
   ){
    info.flags.push('optional')
   }

   const indentation=
    moduleIndentationMap[info.type]?.indentation

   let typeName=unnestName(info.type)

   if(
    indentation!==parent&&
    indentation
   ){
    typeName=
     `${indentation.replaceAll('$','.')}.${typeName}`
   }

   return[
    `${info.flags.join(' ')}${info.flags.length?' ':''}${typeName} ${info.name} = ${info.id}${info.packed||''};`
   ]
  }

  const stringifyMessage=ident=>{
   const members=
    moduleIndentationMap[ident.name]?.members

   const result=[
    `message ${ident.displayName||ident.name} {`,
    ...addPrefix(
     [].concat(
      ...(ident.members||[]).map(
       member=>stringifyMember(
        member,
        true,
        ident.name
       )
      )
     ),
     space
    )
   ]

   if(members?.size){
    for(const memberName of[...members].sort()){
     let entity=modInfo.identifiers[memberName]

     if(entity){
      const displayName=
       entity.name.slice(
        ident.name.length+1
       )

      entity={
       ...entity,
       displayName
      }

      result.push(
       ...addPrefix(
        getEntity(entity),
        space
       )
      )
     }
    }
   }

   result.push('','}')

   return result
  }

  const getEntity=v=>
   v.members
    ?stringifyMessage(v)
    :v.enumValues?.length
     ?stringifyEnum(v)
     :[`// Unknown entity ${v.name}`]

  for(const value of identifiers){
   if(decodedProtoMap[value.name])continue

   const content=getEntity(value).join('\n')

   if(
    !moduleIndentationMap[value.name]?.indentation?.length
   ){
    decodedProtoMap[value.name]=content
   }
  }
 }

 const names=Object.keys(decodedProtoMap).sort()
 const syntax=usesRequired.value?'proto2':'proto3'

 const decodedProtoStr=
  `syntax = "${syntax}";\n`+
  `package proto;\n\n`+
  `/// WhatsApp Version: ${whatsAppVersion}\n\n`+
  `${names.map(name=>decodedProtoMap[name]).join('\n')}`

 await writeFile(
  join(OUT,'WAProto.proto'),
  decodedProtoStr
 )

 const CATEGORIES={
  ai:/^AI|GenAI|Imagine|BotUnifiedResponse/i,
  bot:/^Bot/i,
  interactive:/Interactive|NativeFlow|Carousel|Template|Buttons|List(?!ener)|Collection/i,
  business:/^Biz|Commerce|Order|Invoice|Payment|Catalog|Product/i,
  identity:/^ADV|Cert|VerifiedName|SignedDeviceIdentity/i,
  group:/^Group|Community/i,
  status:/Status|Newsletter/i,
  poll:/Poll/i,
  media:/Sticker|Album|Media(?!DomainInfo)/i,
  protocol:/Protocol|Sync|Handshake|Peer|Device(?!Props)/i,
  call:/Call/i,
  event:/Event/i
 }

 const categorized={}

 for(const name of names){
  const proto=decodedProtoMap[name]
  const hit=Object.entries(CATEGORIES).find(
   ([,re])=>re.test(name)
  )

  const cat=hit?hit[0]:'other'

  categorized[cat]??=[]
  categorized[cat].push({
   name,
   proto
  })
 }

 await writeFile(
  join(OUT,'categorized.json'),
  JSON.stringify(categorized,null,2)
 )

 const rich=
  /richResponseMessage|RichResponseMessage|AIRichResponseMessage|InteractiveMessage|NativeFlowMessage|BotInvokeMessage|GenAI|Carousel|Template|Buttons|List|Flow/i

 const richNames=names.filter(name=>rich.test(name))
 const allMembers=[]

 for(const name of names){
  const proto=decodedProtoMap[name]

  if(rich.test(proto)||rich.test(name)){
   allMembers.push({
    name,
    proto
   })
  }
 }

 await writeFile(
  join(OUT,'rich-response.json'),
  JSON.stringify(allMembers,null,2)
 )

 await writeFile(
  join(OUT,'modules.json'),
  JSON.stringify(
   Object.fromEntries(
    Object.entries(modulesInfo).map(
     ([key,value])=>[
      key,
      {
       crossRefs:value.crossRefs,
       identifiers:Object.values(
        value.identifiers||{}
       ).map(x=>({
        name:x.name,
        alias:x.alias,
        enumValues:x.enumValues,
        members:x.members
       }))
      }
     ]
    )
   ),
   null,
   2
  )
 )

 const catSummary=Object.entries(categorized)
  .map(([key,value])=>`  ${key}: ${value.length}`)
  .join('\n')

 await writeFile(
  join(OUT,'summary.txt'),
  `WhatsApp Version: ${whatsAppVersion}\n`+
  `Sources fetched: ${sources.length}\n`+
  `Modules: ${modules.length}\n`+
  `Messages/Enums: ${names.length}\n`+
  `Rich/Interactive matches: ${richNames.length}\n`+
  `Syntax: ${syntax}\n\n`+
  `Categorías:\n${catSummary}\n\n`+
  `Output: ${OUT}\n`
 )

 try{
  const parsed=protobuf.parse(decodedProtoStr)

  await writeFile(
   join(OUT,'protobuf-validation.json'),
   JSON.stringify(
    {
     valid:true,
     root:parsed.root.toJSON()
    },
    null,
    2
   )
  )
 }catch(e){
  await writeFile(
   join(OUT,'protobuf-validation.json'),
   JSON.stringify(
    {
     valid:false,
     error:String(e?.message||e)
    },
    null,
    2
   )
  )
 }

 console.log(`[PROTO] Sources: ${sources.length}`)
 console.log(`[PROTO] Modules: ${modules.length}`)
 console.log(`[PROTO] Messages/Enums: ${names.length}`)
 console.log(`[PROTO] Rich/Interactive: ${richNames.length}`)
 console.log(`[PROTO] Syntax: ${syntax}`)
 console.log(`[PROTO] Proto: ${join(OUT,'WAProto.proto')}`)
})().catch(e=>{
 console.error('[PROTO ERROR]',e)
 process.exitCode=1
})