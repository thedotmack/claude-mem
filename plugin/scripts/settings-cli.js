#!/usr/bin/env node
import{readFileSync as v,writeFileSync as k,existsSync as m,mkdirSync as w,renameSync as f}from"fs";import{join as P,dirname as j}from"path";import{homedir as D}from"os";var a={model:"claude-sonnet-4-5",workerPort:37777,enableMemoryStorage:!0,enableContextInjection:!0,contextDepth:5},$={model:"AI model to use for processing observations and generating summaries",workerPort:"Port for the background worker service HTTP API",enableMemoryStorage:"Enable/disable saving tool observations to the database",enableContextInjection:"Enable/disable context injection at session start",contextDepth:"Number of recent sessions to load when injecting context (higher = more history, more tokens)"},u=["claude-haiku-4-5","claude-sonnet-4-5","claude-opus-4","claude-3-7-sonnet"],h=class{settingsPath;cachedSettings=null;constructor(t){this.settingsPath=t||P(D(),".claude-mem","settings.json")}loadSettings(){if(this.cachedSettings)return this.cachedSettings;let t={};if(m(this.settingsPath))try{let r=v(this.settingsPath,"utf-8");t=JSON.parse(r)}catch(r){let o=this.settingsPath+".bak";try{f(this.settingsPath,o),console.error(`[claude-mem] Failed to parse settings file: ${r.message}`),console.error(`[claude-mem] Backed up invalid settings to: ${o}`)}catch(i){console.error(`[claude-mem] Failed to parse settings file: ${r.message}`),console.error(`[claude-mem] Could not backup invalid file: ${i.message}`)}}let s={model:t.model??a.model,workerPort:t.workerPort??a.workerPort,enableMemoryStorage:t.enableMemoryStorage??a.enableMemoryStorage,enableContextInjection:t.enableContextInjection??a.enableContextInjection,contextDepth:t.contextDepth??a.contextDepth};return this.validateSettings(s),this.cachedSettings=s,s}validateSettings(t){if(!u.includes(t.model))throw new Error(`Invalid model: ${t.model}. Must be one of: ${u.join(", ")}`);if(typeof t.workerPort!="number"||t.workerPort<1||t.workerPort>65535)throw new Error(`Invalid workerPort: ${t.workerPort}. Must be between 1-65535`);if(typeof t.enableMemoryStorage!="boolean")throw new Error(`Invalid enableMemoryStorage: ${t.enableMemoryStorage}. Must be boolean`);if(typeof t.enableContextInjection!="boolean")throw new Error(`Invalid enableContextInjection: ${t.enableContextInjection}. Must be boolean`);if(typeof t.contextDepth!="number"||t.contextDepth<1||t.contextDepth>50)throw new Error(`Invalid contextDepth: ${t.contextDepth}. Must be between 1-50`)}get(){return this.loadSettings()}getWithDescriptions(){let t=this.get();return{model:{value:t.model,description:$.model,options:u},workerPort:{value:t.workerPort,description:$.workerPort},enableMemoryStorage:{value:t.enableMemoryStorage,description:$.enableMemoryStorage},enableContextInjection:{value:t.enableContextInjection,description:$.enableContextInjection},contextDepth:{value:t.contextDepth,description:$.contextDepth}}}set(t){let r={...this.get(),...t};this.validateSettings(r);let o=j(this.settingsPath);m(o)||w(o,{recursive:!0});try{let i=this.settingsPath+".tmp";k(i,JSON.stringify(r,null,2),"utf-8"),f(i,this.settingsPath),this.cachedSettings=r}catch(i){throw new Error(`Failed to save settings: ${i.message}`)}}reset(){this.set(a)}getDefaults(){return{...a}}getModelOptions(){return[...u]}exists(){return m(this.settingsPath)}getPath(){return this.settingsPath}},p=null;function g(){return p||(p=new h),p}import{existsSync as I}from"fs";var e={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",gray:"\x1B[90m",red:"\x1B[31m"};function M(){console.log(`
${e.bright}claude-mem settings${e.reset}

${e.cyan}USAGE${e.reset}
  settings-cli                           Show current settings (formatted)
  settings-cli --json                    Show current settings (JSON)
  settings-cli --get <key>               Get specific setting value
  settings-cli --set <key>=<value>       Set specific setting
  settings-cli --reset                   Reset to defaults
  settings-cli --help                    Show this help

${e.cyan}SETTINGS${e.reset}
  ${e.green}model${e.reset}                   AI model for processing observations
                              Options: claude-haiku-4-5, claude-sonnet-4-5,
                                       claude-opus-4, claude-3-7-sonnet
                              Default: claude-sonnet-4-5

  ${e.green}workerPort${e.reset}              Port for worker service HTTP API
                              Range: 1-65535
                              Default: 37777

  ${e.green}enableMemoryStorage${e.reset}     Enable/disable saving observations to database
                              Options: true, false
                              Default: true

  ${e.green}enableContextInjection${e.reset}  Enable/disable context injection at session start
                              Options: true, false
                              Default: true

  ${e.green}contextDepth${e.reset}            Number of recent sessions to load in context
                              Range: 1-50
                              Default: 5
                              Higher = more history, more tokens

${e.cyan}EXAMPLES${e.reset}
  ${e.dim}# View current settings${e.reset}
  settings-cli

  ${e.dim}# Change model to haiku${e.reset}
  settings-cli --set model=claude-haiku-4-5

  ${e.dim}# Disable memory storage${e.reset}
  settings-cli --set enableMemoryStorage=false

  ${e.dim}# Set context depth to 10${e.reset}
  settings-cli --set contextDepth=10

  ${e.dim}# Get specific setting${e.reset}
  settings-cli --get model

  ${e.dim}# JSON output (for scripts)${e.reset}
  settings-cli --json

${e.cyan}FILES${e.reset}
  Settings: ${e.gray}~/.claude-mem/settings.json${e.reset}
`)}function c(n){return typeof n=="boolean"?n?`${e.green}${n}${e.reset}`:`${e.red}${n}${e.reset}`:typeof n=="number"?`${e.yellow}${n}${e.reset}`:typeof n=="string"?`${e.cyan}${n}${e.reset}`:String(n)}function y(n=!0){let t=g(),s=t.getPath(),r=I(s);if(console.log(`
${e.bright}${e.cyan}Claude-Mem Settings${e.reset}`),console.log(`${e.gray}${"\u2500".repeat(60)}${e.reset}
`),r?console.log(`${e.dim}Settings file: ${s}${e.reset}
`):(console.log(`${e.yellow}\u26A0 Settings file not found${e.reset}`),console.log(`  ${e.dim}Will be created at: ${s}${e.reset}`),console.log(`  ${e.dim}Using default values${e.reset}
`)),n){let o=t.getWithDescriptions();console.log(`${e.bright}model${e.reset}: ${c(o.model.value)}`),console.log(`  ${e.dim}${o.model.description}${e.reset}`),console.log(`  ${e.dim}Options: ${o.model.options.join(", ")}${e.reset}
`),console.log(`${e.bright}workerPort${e.reset}: ${c(o.workerPort.value)}`),console.log(`  ${e.dim}${o.workerPort.description}${e.reset}
`),console.log(`${e.bright}enableMemoryStorage${e.reset}: ${c(o.enableMemoryStorage.value)}`),console.log(`  ${e.dim}${o.enableMemoryStorage.description}${e.reset}
`),console.log(`${e.bright}enableContextInjection${e.reset}: ${c(o.enableContextInjection.value)}`),console.log(`  ${e.dim}${o.enableContextInjection.description}${e.reset}
`),console.log(`${e.bright}contextDepth${e.reset}: ${c(o.contextDepth.value)}`),console.log(`  ${e.dim}${o.contextDepth.description}${e.reset}
`)}else{let o=t.get();for(let[i,l]of Object.entries(o))console.log(`${e.bright}${i}${e.reset}: ${c(l)}`);console.log()}console.log(`${e.gray}${"\u2500".repeat(60)}${e.reset}`),console.log(`${e.dim}Run 'settings-cli --help' for usage information${e.reset}
`)}function E(n){let s=g().get();n in s||(console.error(`${e.red}Error: Unknown setting '${n}'${e.reset}`),console.error(`${e.dim}Valid settings: ${Object.keys(s).join(", ")}${e.reset}`),process.exit(1));let r=s[n];console.log(JSON.stringify(r))}function O(n){let[t,...s]=n.split("="),r=s.join("=");(!t||r===void 0||r==="")&&(console.error(`${e.red}Error: Invalid format. Use --set key=value${e.reset}`),process.exit(1));let o=g(),i=o.get();t in i||(console.error(`${e.red}Error: Unknown setting '${t}'${e.reset}`),console.error(`${e.dim}Valid settings: ${Object.keys(i).join(", ")}${e.reset}`),process.exit(1));let l,b=typeof i[t];b==="boolean"?r==="true"?l=!0:r==="false"?l=!1:(console.error(`${e.red}Error: '${t}' must be true or false${e.reset}`),process.exit(1)):b==="number"?(l=parseInt(r,10),isNaN(l)&&(console.error(`${e.red}Error: '${t}' must be a number${e.reset}`),process.exit(1))):l=r;try{o.set({[t]:l}),console.log(`${e.green}\u2713${e.reset} Updated ${e.bright}${t}${e.reset} = ${c(l)}`)}catch(x){console.error(`${e.red}Error: ${x.message}${e.reset}`),process.exit(1)}}function C(){g().reset(),console.log(`${e.green}\u2713${e.reset} Settings reset to defaults`),y(!1)}function N(){let t=g().get();console.log(JSON.stringify(t,null,2))}var d=process.argv.slice(2);d.length===0&&(y(!0),process.exit(0));var S=d[0];switch(S){case"--help":case"-h":M();break;case"--json":N();break;case"--get":d.length<2&&(console.error(`${e.red}Error: --get requires a key${e.reset}`),process.exit(1)),E(d[1]);break;case"--set":d.length<2&&(console.error(`${e.red}Error: --set requires key=value${e.reset}`),process.exit(1)),O(d[1]);break;case"--reset":C();break;default:console.error(`${e.red}Error: Unknown flag '${S}'${e.reset}`),console.error(`${e.dim}Run 'settings-cli --help' for usage${e.reset}`),process.exit(1)}
