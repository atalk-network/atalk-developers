from __future__ import annotations

import base64
import hashlib
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
# V1/server parts remain compatible at 8 MiB. V2 uses smaller independently
# authenticated chunks for responsive cancellation and inexpensive retries.
ATTACHMENT_PLAINTEXT_CHUNK_BYTES = 2 * 1024 * 1024


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


def hash_canonical(value: Any) -> str:
    """SHA-512 over canonical JSON, matching @atalk/protocol."""
    return b64url_encode(hashlib.sha512(canonical_bytes(value)).digest())


def hash_b64url_payload(value: str) -> str:
    return b64url_encode(hashlib.sha512(b64url_decode(value)).digest())


def sign_canonical(value: Any, signing_secret_key: str) -> str:
    signature = SigningKey(b64url_decode(signing_secret_key)[:32]).sign(canonical_bytes(value)).signature
    return b64url_encode(signature)


def verify_canonical(value: Any, signature: str, signing_public_key: str) -> bool:
    try:
        VerifyKey(b64url_decode(signing_public_key)).verify(canonical_bytes(value), b64url_decode(signature))
        return True
    except (CryptoError, ValueError, TypeError):
        return False


def seal_group_box(
    *, plaintext: bytes, sender_encryption_secret_key: str,
    recipients: list[dict[str, str]],
) -> dict[str, Any]:
    if not recipients:
        raise ValueError("GROUP_BOX_RECIPIENT_REQUIRED")
    peer_ids = [recipient["peerId"] for recipient in recipients]
    if len(set(peer_ids)) != len(peer_ids):
        raise ValueError("DUPLICATE_GROUP_RECIPIENT")
    content_key = random(SecretBox.KEY_SIZE)
    nonce = random(SecretBox.NONCE_SIZE)
    sender_secret = PrivateKey(b64url_decode(sender_encryption_secret_key))
    wrapped_keys = []
    for recipient in recipients:
        wrap_nonce = random(Box.NONCE_SIZE)
        wrapped_keys.append({
            "recipientPeerId": recipient["peerId"],
            "nonce": b64url_encode(wrap_nonce),
            "ciphertext": b64url_encode(Box(
                sender_secret, PublicKey(b64url_decode(recipient["encryptionPublicKey"])),
            ).encrypt(content_key, wrap_nonce).ciphertext),
        })
    return {
        "nonce": b64url_encode(nonce),
        "ciphertext": b64url_encode(SecretBox(content_key).encrypt(plaintext, nonce).ciphertext),
        "wrappedKeys": wrapped_keys,
    }


def open_group_box(
    *, envelope: dict[str, Any], recipient_peer_id: str,
    recipient_encryption_secret_key: str, sender_encryption_public_key: str,
) -> bytes:
    wrapped = next(
        (item for item in envelope["wrappedKeys"] if item["recipientPeerId"] == recipient_peer_id), None,
    )
    if wrapped is None:
        raise ValueError("GROUP_BOX_RECIPIENT_MISSING")
    try:
        content_key = Box(
            PrivateKey(b64url_decode(recipient_encryption_secret_key)),
            PublicKey(b64url_decode(sender_encryption_public_key)),
        ).decrypt(b64url_decode(wrapped["ciphertext"]), b64url_decode(wrapped["nonce"]))
        return SecretBox(content_key).decrypt(
            b64url_decode(envelope["ciphertext"]), b64url_decode(envelope["nonce"]),
        )
    except (CryptoError, ValueError, KeyError) as error:
        raise ValueError("GROUP_PAYLOAD_DECRYPTION_FAILED") from error


def encrypt_workroom_payload(
    *, envelope_id: str, workroom_id: str, sender_peer_id: str, key_epoch: int,
    payload: dict[str, Any], sender_signing_secret_key: str,
    sender_encryption_secret_key: str, recipients: list[dict[str, str]],
    created_at: str,
) -> dict[str, Any]:
    sealed = seal_group_box(
        plaintext=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(),
        sender_encryption_secret_key=sender_encryption_secret_key,
        recipients=recipients,
    )
    recipient_keys = {
        recipient["peerId"]: recipient["encryptionPublicKey"] for recipient in recipients
    }
    wrapped_keys = [{
        **wrapped,
        "recipientEncryptionKeyHash": hash_b64url_payload(
            recipient_keys[wrapped["recipientPeerId"]],
        ),
    } for wrapped in sealed["wrappedKeys"]]
    unsigned = {
        "version": 1,
        "cipherSuite": "ATALK_GROUP_BOX_V1",
        "envelopeId": envelope_id,
        "workroomId": workroom_id,
        "senderPeerId": sender_peer_id,
        "keyEpoch": key_epoch,
        **sealed,
        "wrappedKeys": wrapped_keys,
        "ciphertextHash": hash_b64url_payload(sealed["ciphertext"]),
        "createdAt": created_at,
    }
    return {**unsigned, "senderSignature": sign_canonical(unsigned, sender_signing_secret_key)}


def decrypt_workroom_payload(
    *, envelope: dict[str, Any], recipient_peer_id: str,
    recipient_encryption_secret_key: str, sender_encryption_public_key: str,
    sender_signing_public_key: str,
) -> dict[str, Any]:
    unsigned = {key: value for key, value in envelope.items() if key != "senderSignature"}
    if (
        envelope.get("cipherSuite") != "ATALK_GROUP_BOX_V1"
        or hash_b64url_payload(str(envelope.get("ciphertext", ""))) != envelope.get("ciphertextHash")
        or not verify_canonical(unsigned, str(envelope.get("senderSignature", "")), sender_signing_public_key)
    ):
        raise ValueError("INVALID_WORKROOM_ENVELOPE")
    plaintext = open_group_box(
        envelope=envelope,
        recipient_peer_id=recipient_peer_id,
        recipient_encryption_secret_key=recipient_encryption_secret_key,
        sender_encryption_public_key=sender_encryption_public_key,
    )
    value = json.loads(plaintext)
    if not isinstance(value, dict):
        raise ValueError("INVALID_WORKROOM_PAYLOAD")
    return value


def decrypt_mandate_terms(
    *, envelope: dict[str, Any], recipient_peer_id: str,
    recipient_encryption_secret_key: str, sender_encryption_public_key: str,
    sender_signing_public_key: str,
) -> dict[str, Any]:
    unsigned = {key: value for key, value in envelope.items() if key != "senderSignature"}
    if (
        hash_b64url_payload(str(envelope.get("ciphertext", ""))) != envelope.get("ciphertextHash")
        or not verify_canonical(unsigned, str(envelope.get("senderSignature", "")), sender_signing_public_key)
    ):
        raise ValueError("INVALID_ENCRYPTED_TERMS")
    value = json.loads(open_group_box(
        envelope=envelope,
        recipient_peer_id=recipient_peer_id,
        recipient_encryption_secret_key=recipient_encryption_secret_key,
        sender_encryption_public_key=sender_encryption_public_key,
    ))
    if not isinstance(value, dict) or not isinstance(value.get("mandate"), dict):
        raise ValueError("INVALID_MANDATE_TERMS_PAYLOAD")
    return value


def verify_signed(value: dict[str, Any], signature_field: str, signing_public_key: str) -> bool:
    signature = value.get(signature_field)
    if not isinstance(signature, str):
        return False
    return verify_canonical(
        {key: field for key, field in value.items() if key != signature_field}, signature, signing_public_key,
    )


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


def create_chunked_attachment_descriptor(
    *, attachment_id: str, size: int, name: str, mime_type: str = "application/octet-stream",
    next_id: Callable[[], str] = lambda: str(__import__("uuid").uuid4()),
) -> dict[str, Any]:
    """Create a v2 descriptor whose chunks can be encrypted and retried independently."""
    if size <= 0:
        raise ValueError("ATTACHMENT_EMPTY")
    if size > MAX_ATTACHMENT_BYTES:
        raise ValueError("ATTACHMENT_TOO_LARGE")
    key = random(SecretBox.KEY_SIZE)
    chunks: list[dict[str, Any]] = []
    offset = 0
    while offset < size:
        plaintext_size = min(ATTACHMENT_PLAINTEXT_CHUNK_BYTES, size - offset)
        chunks.append({
            "id": attachment_id if not chunks else next_id(),
            "plaintextSize": plaintext_size,
            "ciphertextSize": plaintext_size + SecretBox.MACBYTES,
            "nonce": b64url_encode(random(SecretBox.NONCE_SIZE)),
        })
        offset += plaintext_size
    return {
        "version": 2,
        "id": attachment_id,
        "kind": "IMAGE" if mime_type.lower().startswith("image/") else "VIDEO" if mime_type.lower().startswith("video/") else "FILE",
        "name": name,
        "mimeType": mime_type,
        "size": size,
        "ciphertextSize": sum(int(chunk["ciphertextSize"]) for chunk in chunks),
        "key": b64url_encode(key),
        "chunks": chunks,
    }


def encrypt_attachment_chunk(plaintext: bytes, descriptor: dict[str, Any], index: int) -> bytes:
    if int(descriptor.get("version", 1)) != 2:
        raise ValueError("ATTACHMENT_VERSION_UNSUPPORTED")
    try:
        chunk = descriptor["chunks"][index]
    except (IndexError, KeyError, TypeError) as error:
        raise ValueError("ATTACHMENT_SIZE_MISMATCH") from error
    if len(plaintext) != int(chunk["plaintextSize"]):
        raise ValueError("ATTACHMENT_SIZE_MISMATCH")
    return SecretBox(b64url_decode(str(descriptor["key"]))).encrypt(
        plaintext, b64url_decode(str(chunk["nonce"])),
    ).ciphertext


def decrypt_attachment_chunk(ciphertext: bytes, descriptor: dict[str, Any], index: int) -> bytes:
    if int(descriptor.get("version", 1)) != 2:
        raise ValueError("ATTACHMENT_VERSION_UNSUPPORTED")
    try:
        chunk = descriptor["chunks"][index]
    except (IndexError, KeyError, TypeError) as error:
        raise ValueError("ATTACHMENT_SIZE_MISMATCH") from error
    if len(ciphertext) != int(chunk["ciphertextSize"]):
        raise ValueError("ATTACHMENT_SIZE_MISMATCH")
    try:
        plaintext = SecretBox(b64url_decode(str(descriptor["key"]))).decrypt(
            ciphertext, b64url_decode(str(chunk["nonce"])),
        )
    except (CryptoError, ValueError) as error:
        raise ValueError("ATTACHMENT_DECRYPTION_FAILED") from error
    if len(plaintext) != int(chunk["plaintextSize"]):
        raise ValueError("ATTACHMENT_DECRYPTION_FAILED")
    return plaintext


def decrypt_attachment(ciphertext: bytes, descriptor: dict[str, Any]) -> bytes:
    if len(ciphertext) != int(descriptor["ciphertextSize"]):
        raise ValueError("ATTACHMENT_SIZE_MISMATCH")
    if int(descriptor.get("version", 1)) == 2:
        plaintext_parts: list[bytes] = []
        offset = 0
        for index, chunk in enumerate(descriptor["chunks"]):
            size = int(chunk["ciphertextSize"])
            plaintext_parts.append(decrypt_attachment_chunk(ciphertext[offset:offset + size], descriptor, index))
            offset += size
        plaintext = b"".join(plaintext_parts)
        if len(plaintext) != int(descriptor["size"]):
            raise ValueError("ATTACHMENT_DECRYPTION_FAILED")
        return plaintext
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
