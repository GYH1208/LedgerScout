"""Offline JSONL worker. No network calls or credentials; output contains counts only."""
import hashlib
import json
from pathlib import Path
import sys
from importlib.metadata import version

REVISION = "935817c66f5d6e64838f419692545f06787e485f"
HASHES = {
    "v41": "81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99",
    "v4": "97d2f31b020d18b5aee5c9b3d5b4efb10ea210f3fe3f7dffe3f1cd90542d6b19",
}


def main():
    from deepseek_recipe import ChatCompletionRequest, ConversionOptions, DeepseekV4Encoding, DeepseekV41Encoding, Tokenizer

    if version("deepseek-recipe") != "0.2.0":
        raise ValueError("Unsupported encoder")
    model = sys.argv[2]
    manifest = json.loads((Path(sys.argv[1]) / "ready.json").read_text())
    if manifest.get("revision") != REVISION or manifest.get("sha256") != HASHES:
        raise ValueError("Incomplete tokenizer installation")
    encoding, canonical = {"deepseek-flash": ("v41", "DeepSeek-V4.1-Flash"),
                           "deepseek-v4-pro": ("v4", "DeepSeek-V4-Pro")}[model]
    path = Path(sys.argv[1]) / (encoding + ".json")
    if hashlib.sha256(path.read_bytes()).hexdigest() != HASHES[encoding]:
        raise ValueError("Tokenizer checksum mismatch")
    cls = DeepseekV41Encoding if encoding == "v41" else DeepseekV4Encoding
    encoder = cls().with_tokenizer(Tokenizer.from_file(str(path)))
    for line in sys.stdin:
        request = json.loads(line)
        try:
            payload = request["payload"]
            if payload["model"] != model:
                raise ValueError("Model mismatch")
            payload["model"] = canonical
            converted = ChatCompletionRequest(payload).convert(ConversionOptions())
            tokens = len(encoder.encode(converted.conversation))
            result = {"id": request["id"], "tokens": tokens, "encoding": encoding, "revision": REVISION}
        except Exception:
            result = {"id": request.get("id"), "error": "TOKENIZER_FAILED"}
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never echo source messages, local paths or inherited configuration.
        sys.exit(1)
