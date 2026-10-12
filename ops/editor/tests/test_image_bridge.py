import base64
import contextlib
import copy
import http.client
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from image_bridge import ImageBridge, lift_images, MODEL, ORIGIN

IMAGE = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(b"synthetic image bytes").decode()}}

def body(content=None):
    return {"model": MODEL, "stream": True, "max_tokens": 100,
            "messages": [{"role": "assistant", "content": [{"type": "tool_use", "id": "call1", "name": "read_image", "input": {}}]},
                         {"role": "user", "content": content if content is not None else [{"type": "tool_result", "tool_use_id": "call1", "content": [copy.deepcopy(IMAGE)]}]}]}

class Response:
    def __init__(self, status=200, payload=b'data: {"model":"claude-opus-5-5"}\n\ndata: [DONE]\n\n', headers=None):
        self.status=status; self.data=io.BytesIO(payload)
        self.headers=headers or [("Content-Type", "text/event-stream"), ("Transfer-Encoding", "chunked")]
    def getheader(self, name, default=""):
        return next((v for k,v in self.headers if k.lower()==name.lower()),default)
    def getheaders(self): return self.headers
    def read1(self, n): return self.data.read(min(n, 7))

class Connection:
    def __init__(self, response=None, error=False):
        self.response=response or Response(); self.calls=[]; self.error=error; self.closed=False; self.sock=None
    def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.error: raise OSError("never print upstream-secret or private body")
    def getresponse(self): return self.response
    def close(self): self.closed=True

class ImageBridgeTests(unittest.TestCase):
    def request(self, bridge, data=None, path="/v1/messages", token=None, method="POST"):
        conn=http.client.HTTPConnection("127.0.0.1", bridge.server.server_port, timeout=3)
        conn.request(method,path,body=json.dumps(data or body()).encode(),headers={"x-api-key": bridge.token if token is None else token,"Content-Type":"application/json","anthropic-version":"2023-06-01"})
        response=conn.getresponse(); result=(response.status,response.read(),response.getheaders()); conn.close(); return result

    def test_image_only_lift_preserves_bytes_and_tool_association_without_mutation(self):
        original=body(); frozen=copy.deepcopy(original); output,n=lift_images(original)
        self.assertEqual(original,frozen); self.assertEqual(n,1)
        self.assertEqual(output["messages"][1]["content"][0]["tool_use_id"],"call1")
        self.assertEqual(output["messages"][2]["content"][-1],IMAGE)
        self.assertNotIn(IMAGE["source"]["data"],json.dumps(output["messages"][1]))

    def test_mixed_text_multiple_parallel_results_errors_and_top_level_image(self):
        first={"type":"tool_result","tool_use_id":"call1","is_error":True,"content":[{"type":"text","text":"original result"},IMAGE]}
        second={"type":"tool_result","tool_use_id":"call2","content":[IMAGE,{"type":"text","text":"second result"}]}
        source=body([first,second,IMAGE,{"type":"text","text":"user comment"}])
        out,n=lift_images(source); self.assertEqual(n,2)
        c=out["messages"][1]["content"]
        self.assertEqual([v.get("tool_use_id") for v in c[:2]],["call1","call2"])
        self.assertTrue(c[0]["is_error"]); self.assertEqual(c[0]["content"],[{"type":"text","text":"original result"}])
        self.assertEqual(c[2:],source["messages"][1]["content"][2:])
        self.assertEqual(out["messages"][2]["content"][1],IMAGE)
        self.assertEqual(out["messages"][2]["content"][3],IMAGE)

    def test_no_nested_image_is_identical_and_transform_is_idempotent(self):
        source=body([IMAGE,{"type":"tool_result","tool_use_id":"call1","content":"text"}])
        self.assertEqual(lift_images(source),(source,0))
        first,_=lift_images(body()); self.assertEqual(lift_images(first),(first,0))

    def test_invalid_model_image_or_origin_rejected(self):
        for model in ["auto","claude-opus-5-5","other"]:
            with self.assertRaises(ValueError): lift_images(dict(body(),model=model))
        bad=body(); bad["messages"][1]["content"][0]["content"][0]["source"]["data"]="not base64!"
        with self.assertRaises(ValueError):lift_images(bad)
        with self.assertRaises(ValueError):ImageBridge("https://ezr.sh","synthetic")

    def test_stream_bytes_model_status_and_fixed_upstream_headers_unchanged(self):
        c=Connection()
        with patch.object(ImageBridge,"connection",return_value=c), ImageBridge(ORIGIN,"upstream-secret") as b:
            status,payload,headers=self.request(b)
            self.assertEqual(status,200); self.assertEqual(payload,b'data: {"model":"claude-opus-5-5"}\n\ndata: [DONE]\n\n')
            self.assertNotIn("transfer-encoding",dict((k.lower(),v) for k,v in headers))
            self.assertEqual(len(c.calls),1)
            args,kwargs=c.calls[0]; self.assertEqual(args,("POST","/v1/messages"))
            self.assertEqual(kwargs["headers"]["x-api-key"],"upstream-secret")
            self.assertNotIn(b.token,json.dumps(kwargs["headers"]) + kwargs["body"].decode()); self.assertEqual(json.loads(kwargs["body"])["model"],MODEL)
            self.assertEqual(b.evidence()["liftedImages"],1)
        self.assertTrue(c.closed)

    def test_http_error_preserved_without_retry_or_body_log(self):
        payload=b'{"error":{"message":"upstream refusal","model":"claude-opus-5-5"}}'
        c=Connection(Response(400,payload,[("Content-Type","application/json")]))
        stdout=io.StringIO(); stderr=io.StringIO()
        with contextlib.redirect_stdout(stdout),contextlib.redirect_stderr(stderr),patch.object(ImageBridge,"connection",return_value=c),ImageBridge(ORIGIN,"upstream-secret") as b:
            status,result,_=self.request(b); self.assertEqual((status,result),(400,payload));self.assertEqual(len(c.calls),1)
        self.assertEqual(stdout.getvalue()+stderr.getvalue(),"")

    def test_transport_error_no_retry_no_secret_echo(self):
        c=Connection(error=True)
        with patch.object(ImageBridge,"connection",return_value=c),ImageBridge(ORIGIN,"upstream-secret") as b:
            status,result,_=self.request(b);self.assertEqual(status,502);self.assertNotIn(b"upstream-secret",result)
            self.assertEqual(len(c.calls),1);self.assertEqual(b.evidence()["transportErrors"],1)

    def test_redirect_is_never_followed(self):
        c=Connection(Response(307,b"",[("Location","https://attacker.invalid")]))
        with patch.object(ImageBridge,"connection",return_value=c),ImageBridge(ORIGIN,"upstream-secret") as b:
            status,_,headers=self.request(b);self.assertEqual(status,502);self.assertEqual(len(c.calls),1)
            self.assertNotIn("location",dict((k.lower(),v) for k,v in headers))

    def test_auth_path_and_model_reject_before_upstream(self):
        c=Connection()
        with patch.object(ImageBridge,"connection",return_value=c),ImageBridge(ORIGIN,"upstream-secret") as b:
            self.assertEqual(self.request(b,token="wrong")[0],401)
            for path in ["/auto/v1/messages","/v1/models","/v1/messages?redirect=x","https://attacker.invalid/v1/messages"]:
                self.assertEqual(self.request(b,path=path)[0],404)
            self.assertEqual(self.request(b,dict(body(),model="auto"))[0],400)
            self.assertEqual(self.request(b,method="GET")[0],405)
            self.assertEqual(c.calls,[])

    def test_count_tokens_and_sdk_beta_query_keep_same_origin(self):
        c=Connection(Response(200,b'{"input_tokens":99}',[("Content-Type","application/json")]))
        with patch.object(ImageBridge,"connection",return_value=c),ImageBridge(ORIGIN,"upstream-secret") as b:
            self.assertEqual(self.request(b,path="/v1/messages/count_tokens?beta=true")[0],200)
            self.assertEqual(c.calls[0][0],("POST","/v1/messages/count_tokens?beta=true"))

if __name__ == "__main__":unittest.main()
