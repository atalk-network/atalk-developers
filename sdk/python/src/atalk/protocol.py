from __future__ import annotations

import base64
import json
from dataclasses import asdict, dataclass
from typing import Any, Callable

from nacl.exceptions import CryptoError
from nacl.public import Box, PrivateKey, PublicKey
from nacl.secret import SecretBox
from nacl.signing import SigningKey, VerifyKey
from nacl.utils import random

ATTACHMENT_MESSAGE_PREFIX = "__ATALK_ATTACHMENT_V1__"
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
ATTACHMENT_CHUNK_BYTES = 8 * 1024 * 1024


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def canonical_bytes(value: dict[str, Any]) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


@dataclass(frozen=True)
class IdentityKeys:
    signing_public_key: str
    signing_secret_key: str
    encryption_public_key: str
    encryption_secret_key: str

    @classmethod
    def generate(cls) -> "IdentityKeys":
        signing = SigningKey.generate()
        encryption = PrivateKey.generate()
        return cls(
            signing_public_key=b64url_encode(bytes(signing.verify_key)),
            signing_secret_key=b64url_encode(bytes(signing)),
            encryption_public_key=b64url_encode(bytes(encryption.public_key)),
            encryption_secret_key=b64url_encode(bytes(encryption)),
        )


def encrypt_text(
    *,
    message_id: str,
    conversation_id: str,
    sender_peer_id: str,
    recipient_peer_id: str,
    timestamp: str,
    plaintext: str,
    sender_signing_secret_key: str,
    sender_encryption_secret_key: str,
    recipient_encryption_public_key: str,
    nonce: bytes | None = None,
) -> dict[str, Any]:
    actual_nonce = nonce or random(Box.NONCE_SIZE)
    if len(actual_nonce) != Box.NONCE_SIZE:
        raise ValueError("INVALID_NONCE_LENGTH")
    box = Box(
        PrivateKey(b64url_decode(sender_encryption_secret_key)),
        PublicKey(b64url_decode(recipient_encryption_public_key)),
    )
    ciphertext = box.encrypt(plaintext.encode("utf-8"), actual_nonce).ciphertext
    unsigned = {
        "version": 1,
        "message_id": message_id,
        "conversation_id": conversation_id,
        "sender_peer_id": sender_peer_id,
        "recipient_peer_id": recipient_peer_id,
        "timestamp": timestamp,
        "type": "TEXT",
        "nonce": b64url_encode(actual_nonce),
        "ciphertext": b64url_encode(ciphertext),
    }
    signature = SigningKey(b64url_decode(sender_signing_secret_key)).sign(canonical_bytes(unsigned)).signature
    return {**unsigned, "signature": b64url_encode(signature)}


def decrypt_text(
    *,
    envelope: dict[str, Any],
    sender_signing_public_key: str,
    sender_encryption_public_key: str,
    recipient_encryption_secret_key: str,
) -> str:
    signature = b64url_decode(str(envelope["signature"]))
    unsigned = {key: value for key, value in envelope.items() if key != "signature"}
    VerifyKey(b64url_decode(sender_signing_public_key)).verify(canonical_bytes(unsigned), signature)
    box = Box(
        PrivateKey(b64url_decode(recipient_encryption_secret_key)),
        PublicKey(b64url_decode(sender_encryption_public_key)),
    )
    plaintext = box.decrypt(
        b64url_decode(str(envelope["ciphertext"])),
        b64url_decode(str(envelope["nonce"])),
    )
    return plaintext.decode("utf-8")


def keys_to_dict(keys: IdentityKeys) -> dict[str, str]:
    return asdict(keys)


def encrypt_attachment(
    *, attachment_id: str, data: bytes, name: str, mime_type: str = "application/octet-stream",
) -> tuple[dict[str, Any], bytes]:
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise ValueError("ATTACHMENT_TOO_LARGE")
    key = random(SecretBox.KEY_SIZE)
    nonce = random(SecretBox.NONCE_SIZE)
    ciphertext = SecretBox(key).encrypt(data, nonce).ciphertext
    descriptor = {
        "version": 1,
        "id": attachment_id,
        "kind": "IMAGE" if mime_type.lower().startswith("image/") else "VIDEO" if mime_type.lower().startswith("video/") else "FILE",
        "name": name,
        "mimeType": mime_type,
        "size": len(data),
        "ciphertextSize": len(ciphertext),
        "key": b64url_encode(key),
        "nonce": b64url_encode(nonce),
    }
    return descriptor, ciphertext


def decrypt_attachment(ciphertext: bytes, descriptor: dict[str, Any]) -> bytes:
    if len(ciphertext) != int(descriptor["ciphertextSize"]):
        raise ValueError("ATTACHMENT_SIZE_MISMATCH")
    try:
        plaintext = SecretBox(b64url_decode(str(descriptor["key"]))).decrypt(
            ciphertext,
            b64url_decode(str(descriptor["nonce"])),
        )
    except (CryptoError, ValueError) as error:
        raise ValueError("ATTACHMENT_DECRYPTION_FAILED") from error
    if len(plaintext) != int(descriptor["size"]):
        raise ValueError("ATTACHMENT_DECRYPTION_FAILED")
    return plaintext


def split_encrypted_attachment(
    descriptor: dict[str, Any], ciphertext: bytes, next_id: Callable[[], str],
) -> tuple[dict[str, Any], list[tuple[str, bytes]]]:
    parts = [
        (descriptor["id"] if offset == 0 else next_id(), ciphertext[offset:offset + ATTACHMENT_CHUNK_BYTES])
        for offset in range(0, len(ciphertext), ATTACHMENT_CHUNK_BYTES)
    ]
    if len(parts) <= 1:
        return descriptor, parts
    return {
        **descriptor,
        "chunks": [{"id": part_id, "ciphertextSize": len(part)} for part_id, part in parts],
    }, parts


def attachment_part_descriptors(descriptor: dict[str, Any]) -> list[dict[str, Any]]:
    return descriptor.get("chunks") or [{
        "id": descriptor["id"], "ciphertextSize": descriptor["ciphertextSize"],
    }]


def join_encrypted_attachment_parts(parts: list[bytes], descriptor: dict[str, Any]) -> bytes:
    expected = attachment_part_descriptors(descriptor)
    if len(parts) != len(expected):
        raise ValueError("ATTACHMENT_PARTS_MISSING")
    for part, metadata in zip(parts, expected, strict=True):
        if len(part) != int(metadata["ciphertextSize"]):
            raise ValueError("ATTACHMENT_SIZE_MISMATCH")
    ciphertext = b"".join(parts)
    if len(ciphertext) != int(descriptor["ciphertextSize"]):
        raise ValueError("ATTACHMENT_SIZE_MISMATCH")
    return ciphertext


def encode_attachment_message(descriptor: dict[str, Any], caption: str | None = None) -> str:
    payload: dict[str, Any] = {"attachment": descriptor}
    if caption and caption.strip():
        payload["caption"] = caption.strip()
    return ATTACHMENT_MESSAGE_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def decode_attachment_message(value: str) -> dict[str, Any] | None:
    if not value.startswith(ATTACHMENT_MESSAGE_PREFIX):
        return None
    payload = json.loads(value[len(ATTACHMENT_MESSAGE_PREFIX):])
    if not isinstance(payload, dict) or not isinstance(payload.get("attachment"), dict):
        raise ValueError("ATTACHMENT_MESSAGE_INVALID")
    return payload
