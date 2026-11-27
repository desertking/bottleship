import argparse
import gzip
import hashlib
import json
import re
import struct
from pathlib import Path

HASH = re.compile(r"[0-9a-f]{64}")
MIB = 1024 * 1024
MAX_MODULE = 128 * MIB
MAX_PACKAGE = 512 * MIB


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_records(path, compiler_hash):
    with path.open("rb") as stream:
        expected = f"WWTWARM1 {compiler_hash}\n".encode()
        if stream.read(len(expected)) != expected:
            raise ValueError(f"Wrong recording version or compiler in {path}")
        path_size = path.stat().st_size
        while sizes := stream.read(8):
            if len(sizes) != 8:
                raise ValueError(f"Truncated frame in {path}")
            header_size, size = struct.unpack("<II", sizes)
            if not 0 < header_size <= 256 * 1024 or not 0 < size <= MAX_MODULE:
                raise ValueError(f"Invalid frame in {path}")
            header = json.loads(stream.read(header_size))
            offset = stream.tell()
            if offset + size > path_size:
                raise ValueError(f"Truncated module in {path}")
            yield header, path, offset, size
            stream.seek(size, 1)


def module(record):
    _, path, offset, size = record
    with path.open("rb") as stream:
        stream.seek(offset)
        payload = stream.read(size)
    if len(payload) != size or not payload.startswith(b"\0asm\1\0\0\0"):
        raise ValueError(f"Invalid Wasm module at {path}:{offset}")
    return payload


def encode(header, payload):
    meta = json.dumps(header, separators=(",", ":")).encode()
    return struct.pack("<II", len(meta), len(payload)), meta, payload


def build(compiler, output, traces, profile):
    compiler_hash = digest(compiler.read_bytes())
    root = output / compiler_hash
    root.mkdir(parents=True, exist_ok=True)
    manifest = {"version": 1, "compiler": compiler_hash, "pe": {}}
    if profile:
        manifest["profile"] = json.loads(profile.read_bytes())
    pe = {}
    demand = {}
    for path in traces:
        for rec in read_records(path, compiler_hash):
            header = rec[0]
            if header["kind"] == "pe":
                key = header["key"]
                if not HASH.fullmatch(key):
                    raise ValueError(f"Invalid PE key {key}")
                prior = pe.get(key)
                if prior is None or len(header["seeds"]) >= len(prior[0]["seeds"]):
                    pe[key] = rec
            elif header["kind"] == "demand":
                known_hash = header.get("knownHash")
                if known_hash is None:
                    known_hash = digest(",".join(map(str, header["known"])).encode())
                if not HASH.fullmatch(known_hash):
                    raise ValueError(f"Invalid known-entry hash in {path}")
                header.pop("known", None)
                header["knownHash"] = known_hash
                key = tuple(header[k] for k in ("address", "length", "flags", "opt", "code"))
                demand.setdefault((*key, known_hash), rec)
            else:
                raise ValueError(f"Unexpected record kind {header['kind']}")

    remaining = MAX_PACKAGE
    wire_bytes = 0
    for key, rec in pe.items():
        data = module(rec)
        sha = digest(data)
        if len(data) > remaining:
            raise ValueError("PE records exceed package budget")
        spec = {"sha256": sha, "size": len(data), "seeds": rec[0]["seeds"]}
        packed = gzip.compress(data, compresslevel=3, mtime=0)
        if len(packed) < len(data):
            (root / f"{key}-{sha}-gzip.bin").write_bytes(packed)
            spec["gzipSize"] = len(packed)
        else:
            (root / f"{key}-{sha}.wasm").write_bytes(data)
        manifest["pe"][key] = spec
        wire_bytes += spec.get("gzipSize", len(data))
        remaining -= len(data)

    temp = root / "demand.tmp"
    checksum = hashlib.sha256()
    size = count = 0
    groups = {}
    for key, rec in demand.items():
        sha = digest(module(rec))
        identity = (*key[:-1], sha)
        if identity in groups:
            groups[identity][1].append(key[-1])
        else:
            groups[identity] = (rec, [])
    with temp.open("wb") as target, gzip.GzipFile(filename="", mode="wb", fileobj=target, compresslevel=3, mtime=0) as stream:
        covered = 0
        for key, (rec, aliases) in groups.items():
            data = module(rec)
            header = {**rec[0], "sha256": key[-1]}
            if aliases:
                header["knownAliases"] = aliases
            frame = encode(header, data)
            cost = sum(map(len, frame))
            if cost > remaining or len(frame[1]) > 256 * 1024 or count == 65536:
                continue
            for part in frame:
                stream.write(part)
                checksum.update(part)
            count += 1
            covered += 1 + len(aliases)
            size += cost
            remaining -= cost
    if size:
        sha = checksum.hexdigest()
        gzip_size = temp.stat().st_size
        temp.replace(root / f"demand-{sha}-gzip.bin")
        manifest["demand"] = {"sha256": sha, "size": size, "gzipSize": gzip_size}
        wire_bytes += gzip_size
    else:
        temp.unlink()

    data = json.dumps(manifest, separators=(",", ":")).encode()
    if len(data) > 4 * MIB:
        raise ValueError("Manifest exceeds package budget")
    temp = root / "index.tmp"
    temp.write_bytes(data)
    temp.replace(root / "index.json")
    print(json.dumps({"root": str(root), "pe": len(pe), "demand": count, "demandKeys": covered, "omitted": len(demand) - covered,
                      "wasmAndMetadataBytes": MAX_PACKAGE - remaining + len(data), "transferBytes": wire_bytes + len(data)}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("compiler", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("traces", type=Path, nargs="*")
    parser.add_argument("--profile", type=Path)
    args = parser.parse_args()
    build(args.compiler, args.output, args.traces, args.profile)


if __name__ == "__main__":
    main()
