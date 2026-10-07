"""Independent RouterOS API framing, copied from the host compatibility module.

Reference: https://help.mikrotik.com/docs/spaces/ROS/pages/47579160/API
This handles bytes only. It does not implement authentication or execute commands.
"""

from collections.abc import Iterable


class ProtocolError(ValueError):
    pass


def encode_length(length: int) -> bytes:
    if not isinstance(length, int) or isinstance(length, bool) or not 0 <= length <= 0xFFFFFFFF:
        raise ProtocolError('Length must be an unsigned 32-bit integer')
    for limit, flag, width in ((0x80, 0, 1), (0x4000, 0x8000, 2),
                               (0x200000, 0xC00000, 3), (0x10000000, 0xE0000000, 4)):
        if length < limit:
            return (length | flag).to_bytes(width, 'big')
    return b'\xf0' + length.to_bytes(4, 'big')


def decode_length(data: bytes | bytearray, offset: int = 0):
    """Return (length, next offset), or None for an incomplete prefix."""
    if offset < 0 or offset > len(data):
        raise ProtocolError('Invalid offset')
    if offset == len(data):
        return None
    first = data[offset]
    if first < 0x80:
        width, mask = 1, 0x7F
    elif first < 0xC0:
        width, mask = 2, 0x3FFF
    elif first < 0xE0:
        width, mask = 3, 0x1FFFFF
    elif first < 0xF0:
        width, mask = 4, 0xFFFFFFF
    elif first == 0xF0:
        width, mask = 5, 0xFFFFFFFF
    else:
        raise ProtocolError('Unsupported length prefix or control byte')
    if len(data) - offset < width:
        return None
    return int.from_bytes(data[offset:offset + width], 'big') & mask, offset + width


def encode_sentence(words: Iterable[bytes]) -> bytes:
    result = bytearray()
    for word in words:
        if not isinstance(word, bytes) or not word:
            raise ProtocolError('Words must be nonempty bytes; empty words terminate sentences')
        result += encode_length(len(word)) + word
    return bytes(result) + b'\x00'


class SentenceDecoder:
    """Incremental framing with explicit memory limits; discard after any error."""

    def __init__(self, max_word_bytes=1024 * 1024, max_sentence_bytes=4 * 1024 * 1024,
                 max_words=4096):
        if min(max_word_bytes, max_sentence_bytes, max_words) <= 0:
            raise ValueError('Limits must be positive')
        self.max_word_bytes = max_word_bytes
        self.max_sentence_bytes = max_sentence_bytes
        self.max_words = max_words
        self.buffer = bytearray()
        self.words = []
        self.sentence_bytes = 0
        self.failed = False

    def feed(self, data: bytes) -> list[list[bytes]]:
        if self.failed:
            raise ProtocolError('Decoder cannot be reused after an error')
        # Process bounded slices so a large batch of small sentences stays bounded.
        sentences = []
        try:
            for start in range(0, len(data), 4096):
                self.buffer.extend(data[start:start + 4096])
                cursor = 0
                while True:
                    length_info = decode_length(self.buffer, cursor)
                    if length_info is None:
                        break
                    length, after_prefix = length_info
                    if length > self.max_word_bytes:
                        raise ProtocolError('Word exceeds configured limit')
                    if self.sentence_bytes + length > self.max_sentence_bytes:
                        raise ProtocolError('Sentence exceeds configured limit')
                    if length and len(self.words) >= self.max_words:
                        raise ProtocolError('Too many words in sentence')
                    if len(self.buffer) - after_prefix < length:
                        break
                    cursor = after_prefix + length
                    if length == 0:
                        if self.words:  # Empty sentences are ignored by the API.
                            sentences.append(self.words)
                        self.words = []
                        self.sentence_bytes = 0
                    else:
                        self.words.append(bytes(self.buffer[after_prefix:cursor]))
                        self.sentence_bytes += length
                del self.buffer[:cursor]
        except ProtocolError:
            self.failed = True
            self.buffer.clear()
            self.words.clear()
            raise
        return sentences

    def finish(self):
        if self.failed or self.buffer or self.words:
            self.failed = True
            raise ProtocolError('Incomplete or invalid API stream')
