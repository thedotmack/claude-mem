#!/usr/bin/env node
import{readFileSync as x,writeFileSync as v,existsSync as h}from"fs";import{join as w}from"path";import{homedir as k}from"os";var l={model:"claude-sonnet-4-5",workerPort:37777,enableMemoryStorage:!0,enableContextInjection:!0,contextDepth:5},$={model:"AI model to use for processing observations and generating summaries",workerPort:"Port for the background worker service HTTP API",enableMemoryStorage:"Enable/disable saving tool observations to the database",enableContextInjection:"Enable/disable context injection at session start",contextDepth:"Number of recent sessions to load when injecting context (higher = more history, more tokens)"},u=["claude-haiku-4-5","claude-sonnet-4-5","claude-opus-4","claude-3-7-sonnet"],m=class{settingsPath;cachedSettings=null;constructor(t){this.settingsPath=t||w(k(),".claude-mem","settings.json")}loadSettings(){if(this.cachedSettings)return this.cachedSettings;let t={};if(h(this.settingsPath))try{let n=x(this.settingsPath,"utf-8");t=JSON.parse(n)}catch(n){console.error(`[claude-mem] Failed to parse settings file: ${n.message}`)}let s={model:t.model||l.model,workerPort:t.workerPort||l.workerPort,enableMemoryStorage:t.enableMemoryStorage??l.enableMemoryStorage,enableContextInjection:t.enableContextInjection??l.enableContextInjection,contextDepth:t.contextDepth||l.contextDepth};return this.validateSettings(s),this.cachedSettings=s,s}validateSettings(t){if(!u.includes(t.model))throw new Error(`Invalid model: ${t.model}. Must be one of: ${u.join(", ")}`);if(typeof t.workerPort!="number"||t.workerPort<1||t.workerPort>65535)throw new Error(`Invalid workerPort: ${t.workerPort}. Must be between 1-65535`);if(typeof t.enableMemoryStorage!="boolean")throw new Error(`Invalid enableMemoryStorage: ${t.enableMemoryStorage}. Must be boolean`);if(typeof t.enableContextInjection!="boolean")throw new Error(`Invalid enableContextInjection: ${t.enableContextInjection}. Must be boolean`);if(typeof t.contextDepth!="number"||t.contextDepth<1||t.contextDepth>50)throw new Error(`Invalid contextDepth: ${t.contextDepth}. Must be between 1-50`)}get(){return this.loadSettings()}getWithDescriptions(){let t=this.get();return{model:{value:t.model,description:$.model,options:u},workerPort:{value:t.workerPort,description:$.workerPort},enableMemoryStorage:{value:t.enableMemoryStorage,description:$.enableMemoryStorage},enableContextInjection:{value:t.enableContextInjection,description:$.enableContextInjection},contextDepth:{value:t.contextDepth,description:$.contextDepth}}}set(t){let n={...this.get(),...t};this.validateSettings(n);try{v(this.settingsPath,JSON.stringify(n,null,2),"utf-8"),this.cachedSettings=n}catch(r){throw new Error(`Failed to save settings: ${r.message}`)}}reset(){this.set(l)}getDefaults(){return{...l}}getModelOptions(){return[...u]}exists(){return h(this.settingsPath)}getPath(){return this.settingsPath}},p=null;function c(){return p||(p=new m),p}import{existsSync as P}from"fs";var e={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",gray:"\x1B[90m",red:"\x1B[31m"};function j(){console.log(`
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
`)}function a(o){return typeof o=="boolean"?o?`${e.green}${o}${e.reset}`:`${e.red}${o}${e.reset}`:typeof o=="number"?`${e.yellow}${o}${e.reset}`:typeof o=="string"?`${e.cyan}${o}${e.reset}`:String(o)}function S(o=!0){let t=c(),s=t.getPath(),n=P(s);if(console.log(`
${e.bright}${e.cyan}Claude-Mem Settings${e.reset}`),console.log(`${e.gray}${"\u2500".repeat(60)}${e.reset}
`),n?console.log(`${e.dim}Settings file: ${s}${e.reset}
`):(console.log(`${e.yellow}\u26A0 Settings file not found${e.reset}`),console.log(`  ${e.dim}Will be created at: ${s}${e.reset}`),console.log(`  ${e.dim}Using default values${e.reset}
`)),o){let r=t.getWithDescriptions();console.log(`${e.bright}model${e.reset}: ${a(r.model.value)}`),console.log(`  ${e.dim}${r.model.description}${e.reset}`),console.log(`  ${e.dim}Options: ${r.model.options.join(", ")}${e.reset}
`),console.log(`${e.bright}workerPort${e.reset}: ${a(r.workerPort.value)}`),console.log(`  ${e.dim}${r.workerPort.description}${e.reset}
`),console.log(`${e.bright}enableMemoryStorage${e.reset}: ${a(r.enableMemoryStorage.value)}`),console.log(`  ${e.dim}${r.enableMemoryStorage.description}${e.reset}
`),console.log(`${e.bright}enableContextInjection${e.reset}: ${a(r.enableContextInjection.value)}`),console.log(`  ${e.dim}${r.enableContextInjection.description}${e.reset}
`),console.log(`${e.bright}contextDepth${e.reset}: ${a(r.contextDepth.value)}`),console.log(`  ${e.dim}${r.contextDepth.description}${e.reset}
`)}else{let r=t.get();for(let[d,i]of Object.entries(r))console.log(`${e.bright}${d}${e.reset}: ${a(i)}`);console.log()}console.log(`${e.gray}${"\u2500".repeat(60)}${e.reset}`),console.log(`${e.dim}Run 'settings-cli --help' for usage information${e.reset}
`)}function D(o){let s=c().get();o in s||(console.error(`${e.red}Error: Unknown setting '${o}'${e.reset}`),console.error(`${e.dim}Valid settings: ${Object.keys(s).join(", ")}${e.reset}`),process.exit(1));let n=s[o];console.log(JSON.stringify(n))}function I(o){let[t,...s]=o.split("="),n=s.join("=");(!t||n===void 0||n==="")&&(console.error(`${e.red}Error: Invalid format. Use --set key=value${e.reset}`),process.exit(1));let r=c(),d=r.get();t in d||(console.error(`${e.red}Error: Unknown setting '${t}'${e.reset}`),console.error(`${e.dim}Valid settings: ${Object.keys(d).join(", ")}${e.reset}`),process.exit(1));let i,b=typeof d[t];b==="boolean"?n==="true"?i=!0:n==="false"?i=!1:(console.error(`${e.red}Error: '${t}' must be true or false${e.reset}`),process.exit(1)):b==="number"?(i=parseInt(n,10),isNaN(i)&&(console.error(`${e.red}Error: '${t}' must be a number${e.reset}`),process.exit(1))):i=n;try{r.set({[t]:i}),console.log(`${e.green}\u2713${e.reset} Updated ${e.bright}${t}${e.reset} = ${a(i)}`)}catch(y){console.error(`${e.red}Error: ${y.message}${e.reset}`),process.exit(1)}}function M(){c().reset(),console.log(`${e.green}\u2713${e.reset} Settings reset to defaults`),S(!1)}function E(){let t=c().get();console.log(JSON.stringify(t,null,2))}var g=process.argv.slice(2);g.length===0&&(S(!0),process.exit(0));var f=g[0];switch(f){case"--help":case"-h":j();break;case"--json":E();break;case"--get":g.length<2&&(console.error(`${e.red}Error: --get requires a key${e.reset}`),process.exit(1)),D(g[1]);break;case"--set":g.length<2&&(console.error(`${e.red}Error: --set requires key=value${e.reset}`),process.exit(1)),I(g[1]);break;case"--reset":M();break;default:console.error(`${e.red}Error: Unknown flag '${f}'${e.reset}`),console.error(`${e.dim}Run 'settings-cli --help' for usage${e.reset}`),process.exit(1)}
