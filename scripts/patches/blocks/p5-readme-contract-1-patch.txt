   "reasoning"?:str, "usage"?:{...}, "elapsed_ms"?:int, "http_attempts"?:int}
// http_attempts：本次请求实际发出的 HTTP 尝试次数（provider 内部重试已计入）；
//   仅 openai_compat（唯一带重试循环）上报，其余缺省不写 = 未上报（指标落 null，非 0）。