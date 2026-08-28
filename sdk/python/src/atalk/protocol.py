from __future__ import annotations

import base64
import json
from dataclasses import asdict, dataclass
from typing import Any

from nacl.public import Box, PrivateKey, PublicKey
from nacl.signing import SigningKey, VerifyKey
from nacl.utils import random


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
