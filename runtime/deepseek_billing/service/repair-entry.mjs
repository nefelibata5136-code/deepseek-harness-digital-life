// Controlled reload seam for the diagnostic/recovery release; no arbitrary code.
export {mountBillingRuntime as apply} from './runtime.mjs?diagnostics=1';
