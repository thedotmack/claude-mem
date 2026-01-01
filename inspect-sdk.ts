
import * as SDK from '@anthropic-ai/claude-agent-sdk';

console.log('SDK Exports:', Object.keys(SDK));

if (typeof SDK.unstable_v2_createSession === 'function') {
    console.log('unstable_v2_createSession is a function');
} else {
    console.log('unstable_v2_createSession is NOT a function: ', typeof SDK.unstable_v2_createSession);
}
