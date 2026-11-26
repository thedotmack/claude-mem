// Prebundle the official transport and its optional peers. CommonJS gives the
// SDK its supported non-ESM path without a runtime search for npm packages.
export { createGrpcClient } from '@photon-ai/advanced-imessage/grpc';
