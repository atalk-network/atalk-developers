import json
from pathlib import Path

import pytest

from atalk.protocol import (
    b64url_decode,
    b64url_encode,
    create_chunked_attachment_descriptor,
    decode_attachment_message,
    decrypt_attachment,
    decrypt_attachment_chunk,
    decrypt_text,
    encode_attachment_message,
    encrypt_attachment,
    encrypt_attachment_chunk,
    encrypt_text,
    join_encrypted_attachment_parts,
    sign_canonical,
    split_encrypted_attachment,
)


def test_chunked_v2_attachment_round_trip_and_tamper_detection():
    descriptor = create_chunked_attachment_descriptor(
        attachment_id="8952bff1-cec4-4b6a-8077-73417fb75300",
        size=3,
        name="voice.m4a",
        mime_type="audio/mp4",
        next_id=lambda: "8952bff1-cec4-4b6a-8077-73417fb75309",
    )
    ciphertext = encrypt_attachment_chunk(b"abc", descriptor, 0)
    assert descriptor["version"] == 2
    assert decrypt_attachment_chunk(ciphertext, descriptor, 0) == b"abc"
    assert decrypt_attachment(ciphertext, descriptor) == b"abc"
    with pytest.raises(ValueError, match="ATTACHMENT_DECRYPTION_FAILED"):
        decrypt_attachment_chunk(ciphertext[:-1] + bytes([ciphertext[-1] ^ 1]), descriptor, 0)


def test_decrypts_typescript_golden_vector():
    vector_path = Path(__file__).parents[3] / "core" / "protocol" / "test-vectors" / "v1.json"
    vector = json.loads(vector_path.read_text())
    assert decrypt_text(
        envelope=vector["envelope"],
        sender_signing_public_key=vector["sender_signing_public_key"],
        sender_encryption_public_key=vector["sender_encryption_public_key"],
        recipient_encryption_secret_key=vector["recipient_encryption_secret_key"],
    ) == vector["plaintext"]


def test_python_encryption_matches_typescript_golden_vector():
    vector_path = Path(__file__).parents[3] / "core" / "protocol" / "test-vectors" / "v1.json"
    vector = json.loads(vector_path.read_text())
    envelope = vector["envelope"]
    assert encrypt_text(
        message_id=envelope["message_id"],
        conversation_id=envelope["conversation_id"],
        sender_peer_id=envelope["sender_peer_id"],
        recipient_peer_id=envelope["recipient_peer_id"],
        timestamp=envelope["timestamp"],
        plaintext=vector["plaintext"],
        sender_signing_secret_key=vector["sender_signing_secret_seed"],
        sender_encryption_secret_key=vector["sender_encryption_secret_key"],
        recipient_encryption_public_key=vector["recipient_encryption_public_key"],
        nonce=b64url_decode(envelope["nonce"]),
    ) == envelope


def test_python_encryption_accepts_typescript_64_byte_signing_secret():
    vector_path = Path(__file__).parents[3] / "core" / "protocol" / "test-vectors" / "v1.json"
    vector = json.loads(vector_path.read_text())
    envelope = vector["envelope"]
    typescript_secret = b64url_encode(
        b64url_decode(vector["sender_signing_secret_seed"])
        + b64url_decode(vector["sender_signing_public_key"])
    )
    assert len(b64url_decode(typescript_secret)) == 64
    assert sign_canonical(envelope, typescript_secret) == sign_canonical(
        envelope, vector["sender_signing_secret_seed"],
    )
    assert encrypt_text(
        message_id=envelope["message_id"],
        conversation_id=envelope["conversation_id"],
        sender_peer_id=envelope["sender_peer_id"],
        recipient_peer_id=envelope["recipient_peer_id"],
        timestamp=envelope["timestamp"],
        plaintext=vector["plaintext"],
        sender_signing_secret_key=typescript_secret,
        sender_encryption_secret_key=vector["sender_encryption_secret_key"],
        recipient_encryption_public_key=vector["recipient_encryption_public_key"],
        nonce=b64url_decode(envelope["nonce"]),
    ) == envelope


@pytest.mark.parametrize("secret_size", [0, 31, 33, 63, 65])
def test_python_signing_rejects_invalid_secret_key_lengths(secret_size):
    vector_path = Path(__file__).parents[3] / "core" / "protocol" / "test-vectors" / "v1.json"
    vector = json.loads(vector_path.read_text())
    envelope = vector["envelope"]
    invalid_secret = b64url_encode(b"x" * secret_size)

    with pytest.raises(ValueError, match="INVALID_SIGNING_SECRET_KEY_LENGTH"):
        sign_canonical({"message": "invalid key"}, invalid_secret)
    with pytest.raises(ValueError, match="INVALID_SIGNING_SECRET_KEY_LENGTH"):
        encrypt_text(
            message_id=envelope["message_id"],
            conversation_id=envelope["conversation_id"],
            sender_peer_id=envelope["sender_peer_id"],
            recipient_peer_id=envelope["recipient_peer_id"],
            timestamp=envelope["timestamp"],
            plaintext=vector["plaintext"],
            sender_signing_secret_key=invalid_secret,
            sender_encryption_secret_key=vector["sender_encryption_secret_key"],
            recipient_encryption_public_key=vector["recipient_encryption_public_key"],
            nonce=b64url_decode(envelope["nonce"]),
        )


def test_attachment_round_trip_and_tamper_detection():
    plaintext = b"invoice,total\nINV-42,1250.00\n"
    descriptor, ciphertext = encrypt_attachment(
        attachment_id="8952bff1-cec4-4b6a-8077-73417fb75301",
        data=plaintext,
        name="invoice.csv",
        mime_type="text/csv",
    )
    encoded = encode_attachment_message(descriptor, "Please process this invoice")
    decoded = decode_attachment_message(encoded)

    assert decoded == {"attachment": descriptor, "caption": "Please process this invoice"}
    assert decrypt_attachment(ciphertext, descriptor) == plaintext
    with pytest.raises(ValueError):
        decrypt_attachment(ciphertext[:-1] + bytes([ciphertext[-1] ^ 1]), descriptor)


def test_large_attachment_is_split_and_reassembled():
    plaintext = b"x" * (9 * 1024 * 1024)
    descriptor, ciphertext = encrypt_attachment(
        attachment_id="8952bff1-cec4-4b6a-8077-73417fb75302",
        data=plaintext,
        name="video.mp4",
        mime_type="video/mp4",
    )
    identifiers = iter(["8952bff1-cec4-4b6a-8077-73417fb75303"])
    descriptor, parts = split_encrypted_attachment(descriptor, ciphertext, lambda: next(identifiers))
    assert [len(part) for _, part in parts] == [8 * 1024 * 1024, 1 * 1024 * 1024 + 16]
    joined = join_encrypted_attachment_parts([part for _, part in parts], descriptor)
    assert decrypt_attachment(joined, descriptor) == plaintext
