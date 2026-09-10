from tg_archive.model import ChatInfo
from tg_archive.normalizer import normalize_message, peer_to_chat_id


class FakeMessage:
    def __init__(self, raw: dict):
        self._raw = raw

    def to_dict(self):
        return self._raw


def test_peer_channel_id():
    assert peer_to_chat_id({"_": "PeerChannel", "channel_id": 1234567890}) == -1001234567890
    assert peer_to_chat_id({"_": "PeerChannel", "channel_id": 123456789}) == -1000123456789
    assert peer_to_chat_id({"_": "PeerUser", "user_id": 42}) == 42
    assert peer_to_chat_id({"_": "PeerChat", "chat_id": 7}) == 7
    assert peer_to_chat_id(None) is None


def test_normalize_text_message():
    msg = FakeMessage(
        {
            "id": 12,
            "peer_id": {"_": "PeerChannel", "channel_id": 1234567890},
            "date": "2026-09-07T04:00:00+00:00",
            "message": "hello archive",
            "from_id": {"_": "PeerUser", "user_id": 42},
            "out": False,
        }
    )
    nm = normalize_message(msg)
    assert nm.tg_chat_id == -1001234567890
    assert nm.tg_message_id == 12
    assert nm.content_type == "text"
    assert nm.text == "hello archive"
    assert nm.sender_id == 42
    assert not nm.has_media
    assert nm.can_be_saved is True


def test_normalize_photo_album():
    raw = {
        "id": 3,
        "peer_id": {"_": "PeerUser", "user_id": 9},
        "date": "2026-09-01T08:30:00+00:00",
        "message": "caption text",
        "media": {"_": "MessageMediaPhoto", "photo": {"id": 991, "dc_id": 2}},
        "grouped_id": 777,
        "from_id": {"_": "PeerUser", "user_id": 9},
    }
    nm = normalize_message(FakeMessage(raw))
    assert nm.content_type == "photo"
    assert nm.has_media
    assert nm.grouped_id == 777
    assert nm.media[0]["kind"] == "Photo"


def test_normalize_video_document():
    raw = {
        "id": 5,
        "peer_id": {"_": "PeerChat", "chat_id": 99},
        "date": "2026-08-01T00:00:00+00:00",
        "message": "",
        "media": {
            "_": "MessageMediaDocument",
            "document": {
                "id": 5,
                "size": 1000,
                "attributes": [
                    {
                        "_": "DocumentAttributeFilename",
                        "file_name": "clip.mp4",
                    },
                    {
                        "_": "DocumentAttributeVideo",
                        "duration": 30,
                        "w": 1280,
                        "h": 720,
                    },
                ],
            },
        },
    }
    nm = normalize_message(FakeMessage(raw))
    assert nm.content_type == "video"
    assert nm.media[0]["file_name"] == "clip.mp4"


def test_service_and_protection():
    raw = {
        "id": 1,
        "peer_id": {"_": "PeerChannel", "channel_id": 1},
        "date": "2026-09-07T00:00:00+00:00",
        "message": "",
        "action": {"_": "MessageActionChatEditTitle", "title": "new"},
    }
    nm = normalize_message(FakeMessage(raw))
    assert nm.is_service
    assert nm.content_type == "service"

    chat = ChatInfo(
        tg_chat_id=-1000000000001,
        type="channel",
        has_protected_content=True,
    )
    nm2 = normalize_message(FakeMessage({**raw, "message": "text", "action": None}), chat)
    assert nm2.can_be_saved is False
