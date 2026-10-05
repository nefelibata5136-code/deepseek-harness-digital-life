"""Official SDK transport. CLI profile is a credential source, never a process.

OAuth refresh and STS exchange are owned by Alibaba's credentials provider.
No raw SDK errors, credentials, signed URLs or provider responses are logged.
"""
import asyncio
import json
import logging

from alibabacloud_credentials.client import Client as CredentialsClient
from alibabacloud_credentials.provider import CLIProfileCredentialsProvider
from alibabacloud_green20220302.client import Client as GreenClient
from alibabacloud_green20220302.models import ImageModerationRequest
from alibabacloud_tea_openapi.utils_models import Config
from darabonba.runtime import RuntimeOptions


class AliyunOCRClient:
    def __init__(self, config):
        # SDK warnings may embed raw exception bodies on OAuth refresh failure.
        logging.getLogger('credentials').disabled = True
        self.provider = CLIProfileCredentialsProvider(profile_name=config['profile'])
        self.credentials = CredentialsClient(provider=self.provider)
        self.client = GreenClient(Config(
            credential=self.credentials, region_id=config['region'],
            endpoint=config['endpoint'], protocol='https',
            connect_timeout=5000, read_timeout=20000))
        self.runtime = RuntimeOptions(autoretry=False, max_attempts=1,
                                      connect_timeout=5000, read_timeout=20000)

    async def call(self, action, params=None):
        from general_ocr import OcrError
        try:
            if action == 'DescribeUploadToken':
                response = await self.client.describe_upload_token_with_options_async(self.runtime)
            elif action == 'ImageModeration':
                params = params or {}
                if params.get('Service') != 'generalOcr':
                    raise OcrError('OCR_SERVICE_NOT_ALLOWED')
                request = ImageModerationRequest(service='generalOcr',
                    service_parameters=params['ServiceParameters'])
                response = await self.client.image_moderation_with_options_async(request, self.runtime)
            else:
                raise OcrError('OCR_ACTION_NOT_ALLOWED')
            return response.body.to_map()
        except OcrError:
            raise
        except asyncio.CancelledError:
            raise
        except Exception:
            # Exception strings can contain the signed request or token response.
            raise OcrError('ALIYUN_SDK_AUTH_OR_CALL_FAILED') from None
