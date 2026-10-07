"""CLI transport for benchmark only; never imported by production MCP."""
import asyncio,json,os
from pathlib import Path
from general_ocr import GeneralOCR,OcrError

class CLIGeneralOCR(GeneralOCR):
    def __init__(self,config):
        super().__init__(config);self.transport=self
    async def call(self,action,params=None):
        c=self.config;cli=Path(c['cli_path'])
        if not cli.is_file():raise OcrError('ALIYUN_CLI_NOT_FOUND')
        args=[str(cli),'green',action,'--version',c['api_version'],'--region',c['region'],'--endpoint',c['endpoint'],'--profile',c['profile'],'--cli-output','json']
        for key,value in (params or {}).items():args+=['--'+key,value]
        proc=await asyncio.create_subprocess_exec(*args,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,
            **({'creationflags':0x08000000} if os.name=='nt' else {}))
        try:stdout,stderr=await asyncio.wait_for(proc.communicate(),40)
        except (TimeoutError,asyncio.CancelledError):
            if proc.returncode is None:proc.kill()
            await proc.communicate();raise OcrError('OCR_REQUEST_STATUS_UNCERTAIN_DO_NOT_AUTORETRY')
        # Neither stderr nor malformed stdout are emitted or saved: may contain URLs.
        try:body=json.loads(stdout)
        except Exception:raise OcrError('ALIYUN_CLI_AUTH_OR_RESPONSE_FAILED') from None
        if proc.returncode!=0:
            code=body.get('Code') or body.get('code') or body.get('error',{}).get('code')
            safe=str(code) if code and str(code).replace('.','').replace('_','').isalnum() and len(str(code))<100 else 'ALIYUN_CLI_CALL_FAILED'
            raise OcrError(safe)
        return body
