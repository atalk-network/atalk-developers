import json
from pathlib import Path

from atalk.protocol import b64url_decode, decrypt_text, encrypt_text


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
