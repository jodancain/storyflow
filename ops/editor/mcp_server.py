"""Minimal private stdio MCP server. stdout is JSON-RPC only."""
import json
import os
import sys
from sandbox import Sandbox, MAX_IMAGE_BYTES, ImageReadLimitError, tools_for, dispatch

def main():
    box = Sandbox(os.environ["EDITOR_TASK_WORK"], os.environ["EDITOR_TASK_INPUT"],
                  image_max_bytes=int(os.environ.get("EDITOR_IMAGE_MAX_BYTES", str(MAX_IMAGE_BYTES))))
    # No API key reaches tool execution or persists in this server's environment.
    os.environ.clear()
    for line in sys.stdin:
        if len(line) > 2 * 1024 * 1024: break
        try:
            req = json.loads(line)
            if "id" not in req: continue
            method = req.get("method")
            if method == "initialize":
                result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "storyflow-editor", "version": "1.0.0"}}
            elif method == "ping": result = {}
            elif method == "tools/list": result = {"tools": tools_for(box)}
            elif method == "tools/call":
                params = req.get("params", {})
                try:
                    value = dispatch(box, params["name"], params.get("arguments", {}))
                    result = {"content": [value] if params["name"] == "read_image" else [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}]}
                except ImageReadLimitError as error:
                    result = {"isError": True, "content": [{"type": "text", "text": str(error)}]}
                except Exception:
                    result = {"isError": True, "content": [{"type": "text", "text": "tool rejected, invalid path/arguments, sandbox unavailable, or execution failed"}]}
            else:
                print(json.dumps({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32601, "message": "method not found"}}), flush=True)
                continue
            print(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}, ensure_ascii=False), flush=True)
        except Exception:
            print(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}}), flush=True)

if __name__ == "__main__": main()
