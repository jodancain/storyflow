#!/usr/bin/env python3
"""Import an explicitly authorized, frozen image batch; never calls a provider.

Usage: python3 scripts/import-image-batch.py /path/to/batch
Only decoded deliverable variants from manifest.json are copied. Provider receipts,
credentials, prompts, original reference photos and private run logs are excluded.
"""
import hashlib
import json
import shutil
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
batch = Path(sys.argv[1]).resolve()
manifest = json.loads((batch / "manifest.json").read_text())
path = root / "examples/lupus-v6.assets.json"
result = json.loads(path.read_text())
ontology = json.loads((root / "examples/lupus-v6.json").read_text())
asset_ids = {a["id"] for a in ontology["assets"]}
shot_ids = {s["id"] for s in ontology["shots"]}
result["version"] = 2
result["candidates"] = []
result["imageAttempts"] = []
for ref in result["files"]:
    ref["publicShareApproved"] = True


def copy_variant(value):
    source = (batch / value["path"]).resolve()
    if batch not in source.parents or source.suffix not in (".png", ".jpg", ".webp"):
        raise ValueError("Invalid image path")
    content = source.read_bytes()
    if hashlib.sha256(content).hexdigest() != value["sha256"]:
        raise ValueError("Image hash mismatch")
    relative = Path("assets/generated") / value["path"]
    destination = root / "examples" / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    return {"path": str(relative), "sha256": value["sha256"],
            "mime": {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}[source.suffix],
            "publicShareApproved": True}


for item in manifest["items"]:
    target = {"assetId" if item["targetKind"] == "asset" else "shotId": item["id"]}
    if item["status"] != "generated":
        if item["status"] not in ("failed", "blocked_provider_policy"):
            raise ValueError("Batch must finish before import")
        result["imageAttempts"].append({
            "target": target, "origin": "external-history",
            "state": "failed" if item["status"] == "failed" else "blocked",
            "code": "moderation_blocked" if item["id"] == "A-SYM-FOAM" else "blocked_provider_policy",
            "submitted": item.get("imagePostNumber") is not None,
            "reason": "供应商拒绝了此图请求；本轮不重试。" if item["id"] == "A-SYM-FOAM" else "前置泡沫示意图被供应商拒绝；本镜未提交。",
            "modelRequested": item.get("requestedModel"), "modelActual": item.get("actualModel"),
            "blockingParent": item.get("blockingParent"), "sourceStoryHash": manifest["storyHash"],
            **({"imagePostNumber": item["imagePostNumber"]} if item.get("imagePostNumber") is not None else {}),
        })
        continue
    primary = item["original"] if item["targetKind"] == "asset" else item["portrait"]
    review = item.get("technicalReview") or {}
    notes = review.get("notes") or []
    if isinstance(notes, str):
        notes = [notes]
    parents = item.get("parents") or []
    metadata = {
        "origin": "ai-generated", "reviewStatus": "pending",
        "modelRequested": item.get("requestedModel"), "modelActual": item.get("actualModel"),
        "productionMethod": item.get("productionMethod") or "image-provider",
        "parentAssets": [{"assetId": p["id"], "sha256": p["sha256"]} for p in parents if p["id"] in asset_ids],
        "parentShots": [{"shotId": p["id"], "sha256": p["sha256"]} for p in parents if p["id"] in shot_ids],
        "externalReferences": [{"role": "user-authorized-private-reference", "sha256": p["sha256"], "included": False} for p in parents if p["id"] not in asset_ids and p["id"] not in shot_ids],
        "technicalReview": review, "reviewNote": "；".join(notes),
        "promptHash": item.get("promptHash"), "requestId": item.get("requestId"),
        "httpStatus": item.get("httpStatus"), "imagePostNumber": item.get("imagePostNumber"),
        "generatedAt": item.get("completedAt"), "programHash": item.get("programHash"),
        "generationSnapshotHash": manifest["storyHash"], "sourceUrls": item.get("sourceUrls", []),
        "crop": item["portrait"], "firstFrameBound": False,
    }
    result["candidates"].append({"target": target, **copy_variant(primary),
        **({"original": copy_variant(item["original"])} if item["targetKind"] == "shot" else {}), "thumbnail": copy_variant(item["thumbnail"]),
        "sourceHash": manifest["storyHash"], "metadata": metadata})

result["batch"] = {k: manifest[k] for k in ("schema", "storyHash", "assetTargetCount", "shotTargetCount", "imagePosts", "imagePostLimit", "imageRetries", "generatedCount", "approvedCount", "allCandidatesNeedHumanReview", "actualModelPolicy")}
path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"candidates": len(result["candidates"]), "attempts": result["imageAttempts"], "batch": result["batch"]}, ensure_ascii=False, indent=2))
