const messages={
 BILLING_LOGIN_REQUIRED:['authentication','账单专用浏览器登录已失效，需要用户本人重新登录。',true],
 BILLING_VERIFICATION_REQUIRED:['verification','DeepSeek 页面要求人机验证，需要用户本人完成。',true],
 BILLING_RESPONSE_TIMEOUT:['response','官网页面未在规定时间内产生按 Key 账单响应。',false],
 BILLING_NAVIGATION_TIMEOUT:['network','官网页面加载超时，请检查网络后重试。',false],
 BILLING_PROFILE_IN_USE:['browser','账单专用浏览器正在被另一个进程使用。',false],
 BILLING_KEY_MAPPING_UNAVAILABLE:['mapping','官方 Key identity 与 Host 凭据映射校验失败，禁止猜测归属。',false],
 OFFICIAL_BILLING_UNAVAILABLE:['official_api','官方账单接口返回业务失败或不符合校验条件。',false],
 BILLING_SNAPSHOT_INVALID:['validation','官方账单快照日期或金额校验失败。',false],
 BILLING_WORKER_START_FAILED:['host','Host 无法启动账单查询进程。',false],
 BILLING_WORKER_TIMEOUT:['host','常驻账单查询进程超过90秒未返回；Host 将重建受控 worker。',false],
 BILLING_WORKER_EXITED:['host','常驻账单查询进程已退出；下一次重试会重建。',false],
 BILLING_WORKER_OUTPUT_INVALID:['validation','账单 worker 的安全响应格式或大小校验失败。',false],
 BILLING_LAUNCH_FAILED:['browser','无法启动账单专用浏览器；检查 Chrome 安装或 profile 占用。',false],
 BILLING_NAVIGATION_FAILED:['network','无法打开 DeepSeek Usage 页面；检查网络后重试。',false],
 BILLING_RESPONSE_FAILED:['response','官网账单 response 无法读取或解析。',false],
 BILLING_VERIFICATION_FAILED:['validation','账单响应结构校验失败；检查官方 schema 变化。',false],
 BILLING_CURRENCY_UNSUPPORTED:['validation','官方账单货币不是预期 CNY；拒绝将其他货币当人民币。',false]
};
export function billingError(state){
 if(!state?.last_error)return null;
 const code=Object.hasOwn(messages,state.last_error)?state.last_error:'OFFICIAL_REFRESH_FAILED';
 const [layer,message,human]=messages[code]??['host','官方账单刷新失败；请读取安全诊断并按维护指南定位。',false];
 return {code,layer,message,failed_at:state.last_completed_at??state.last_attempt_at??null,
  consecutive_failures:state.consecutive_failures??1,human_required:human,
  recovery:{tool:'billing_recover',can_retry:!human,steps:human?
   ['保留旧金额并注明过期，不用本地估算替代。','调用 billing_recover 查看恢复步骤；请用户在专用浏览器手动登录或完成验证。','用户完成后调用 billing_recover(action="retry")，再读 billing_status 确认错误已清除。']:
   ['调用 billing_recover(action="retry") 请求一次有节流的后台重试。','读取 billing_status 确认更新时间前进且 stale=false。','仍失败则在本人工作区读取账单源码快照、制作候选并跑定向测试；保护侧正式发布走既有维护权限。']}};
}
