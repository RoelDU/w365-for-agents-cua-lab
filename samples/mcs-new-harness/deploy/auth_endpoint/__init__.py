import asyncio

import azure.functions as func

from mcs_new_harness.stage_app import app


middleware = func.AsgiMiddleware(app)
startup_lock = asyncio.Lock()
started = False


async def main(req: func.HttpRequest, context: func.Context) -> func.HttpResponse:
    global started
    async with startup_lock:
        if not started:
            if not await middleware.notify_startup():
                raise RuntimeError("Authentication-only ASGI startup failed")
            started = True
    return await middleware.handle_async(req, context)
