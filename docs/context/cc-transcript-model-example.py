"""Pydantic models for Claude Code transcript JSON structures.

Enhanced to leverage official Anthropic types where beneficial.
"""

from typing import Any, List, Union, Optional, Dict, Literal, cast
from pydantic import BaseModel

from anthropic.types import Message as AnthropicMessage
from anthropic.types import StopReason
from anthropic.types import Usage as AnthropicUsage
from anthropic.types.content_block import ContentBlock


class TodoItem(BaseModel):
    id: str
    content: str
    status: Literal["pending", "in_progress", "completed"]
    priority: Literal["high", "medium", "low"]


class UsageInfo(BaseModel):
    """Token usage information that extends Anthropic's Usage type to handle optional fields."""

    input_tokens: Optional[int] = None
    cache_creation_input_tokens: Optional[int] = None
    cache_read_input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    service_tier: Optional[str] = None
    server_tool_use: Optional[Dict[str, Any]] = None

    def to_anthropic_usage(self) -> Optional[AnthropicUsage]:
        """Convert to Anthropic Usage type if both required fields are present."""
        if self.input_tokens is not None and self.output_tokens is not None:
            return AnthropicUsage(
                input_tokens=self.input_tokens,
                output_tokens=self.output_tokens,
                cache_creation_input_tokens=self.cache_creation_input_tokens,
                cache_read_input_tokens=self.cache_read_input_tokens,
                service_tier=self.service_tier,  # type: ignore
                server_tool_use=self.server_tool_use,  # type: ignore
            )
        return None

    @classmethod
    def from_anthropic_usage(cls, usage: AnthropicUsage) -> "UsageInfo":
        """Create UsageInfo from Anthropic Usage."""
        return cls(
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cache_creation_input_tokens=usage.cache_creation_input_tokens,
            cache_read_input_tokens=usage.cache_read_input_tokens,
            service_tier=usage.service_tier,
            server_tool_use=usage.server_tool_use.model_dump()
            if usage.server_tool_use
            else None,
        )


class TextContent(BaseModel):
    type: Literal["text"]
    text: str


class ToolUseContent(BaseModel):
    type: Literal["tool_use"]
    id: str
    name: str
    input: Dict[str, Any]


class ToolResultContent(BaseModel):
    type: Literal["tool_result"]
    tool_use_id: str
    content: Union[str, List[Dict[str, Any]]]
    is_error: Optional[bool] = None


class ThinkingContent(BaseModel):
    type: Literal["thinking"]
    thinking: str
    signature: Optional[str] = None


class ImageSource(BaseModel):
    type: Literal["base64"]
    media_type: str
    data: str


class ImageContent(BaseModel):
    type: Literal["image"]
    source: ImageSource


# Enhanced ContentItem to include official Anthropic ContentBlock types
ContentItem = Union[
    TextContent,
    ToolUseContent,
    ToolResultContent,
    ThinkingContent,
    ImageContent,
    ContentBlock,  # Official Anthropic content block types
]


class UserMessage(BaseModel):
    role: Literal["user"]
    content: Union[str, List[ContentItem]]


class AssistantMessage(BaseModel):
    """Assistant message model compatible with Anthropic's Message type."""

    id: str
    type: Literal["message"]
    role: Literal["assistant"]
    model: str
    content: List[ContentItem]
    stop_reason: Optional[StopReason] = None
    stop_sequence: Optional[str] = None
    usage: Optional[UsageInfo] = None

    @classmethod
    def from_anthropic_message(
        cls, anthropic_msg: AnthropicMessage
    ) -> "AssistantMessage":
        """Create AssistantMessage from official Anthropic Message."""
        # Convert Anthropic Message to our format, preserving official types where possible
        return cls(
            id=anthropic_msg.id,
            type=anthropic_msg.type,
            role=anthropic_msg.role,
            model=anthropic_msg.model,
            content=list(
                anthropic_msg.content
            ),  # Convert to list for ContentItem compatibility
            stop_reason=anthropic_msg.stop_reason,
            stop_sequence=anthropic_msg.stop_sequence,
            usage=normalize_usage_info(anthropic_msg.usage),
        )


class FileInfo(BaseModel):
    filePath: str
    content: str
    numLines: int
    startLine: int
    totalLines: int


class FileReadResult(BaseModel):
    type: Literal["text"]
    file: FileInfo


class CommandResult(BaseModel):
    stdout: str
    stderr: str
    interrupted: bool
    isImage: bool


class TodoResult(BaseModel):
    oldTodos: List[TodoItem]
    newTodos: List[TodoItem]


class EditResult(BaseModel):
    oldString: Optional[str] = None
    newString: Optional[str] = None
    replaceAll: Optional[bool] = None
    originalFile: Optional[str] = None
    structuredPatch: Optional[Any] = None
    userModified: Optional[bool] = None


ToolUseResult = Union[
    str,
    List[TodoItem],
    FileReadResult,
    CommandResult,
    TodoResult,
    EditResult,
    List[ContentItem],
]


class BaseTranscriptEntry(BaseModel):
    parentUuid: Optional[str]
    isSidechain: bool
    userType: str
    cwd: str
    sessionId: str
    version: str
    uuid: str
    timestamp: str
    isMeta: Optional[bool] = None


class UserTranscriptEntry(BaseTranscriptEntry):
    type: Literal["user"]
    message: UserMessage
    toolUseResult: Optional[ToolUseResult] = None


class AssistantTranscriptEntry(BaseTranscriptEntry):
    type: Literal["assistant"]
    message: AssistantMessage
    requestId: Optional[str] = None


class SummaryTranscriptEntry(BaseModel):
    type: Literal["summary"]
    summary: str
    leafUuid: str
    cwd: Optional[str] = None


class SystemTranscriptEntry(BaseTranscriptEntry):
    """System messages like warnings, notifications, etc."""

    type: Literal["system"]
    content: str
    level: Optional[str] = None  # e.g., "warning", "info", "error"


class QueueOperationTranscriptEntry(BaseModel):
    """Queue operations (enqueue/dequeue) for message queueing tracking.

    These are internal operations that track when messages are queued and dequeued.
    They are parsed but not rendered, as the content duplicates actual user messages.
    """

    type: Literal["queue-operation"]
    operation: Literal["enqueue", "dequeue"]
    timestamp: str
    sessionId: str
    content: Optional[List[ContentItem]] = None  # Only present for enqueue operations


TranscriptEntry = Union[
    UserTranscriptEntry,
    AssistantTranscriptEntry,
    SummaryTranscriptEntry,
    SystemTranscriptEntry,
    QueueOperationTranscriptEntry,
]


def normalize_usage_info(usage_data: Any) -> Optional[UsageInfo]:
    """Normalize usage data to be compatible with both custom and Anthropic formats."""
    if usage_data is None:
        return None

    # If it's already a UsageInfo instance, return as-is
    if isinstance(usage_data, UsageInfo):
        return usage_data

    # If it's an Anthropic Usage instance, convert using our method
    if isinstance(usage_data, AnthropicUsage):
        return UsageInfo.from_anthropic_usage(usage_data)

    # If it has the shape of an Anthropic Usage, try to construct it first
    if hasattr(usage_data, "input_tokens") and hasattr(usage_data, "output_tokens"):
        try:
            # Try to create an Anthropic Usage first
            anthropic_usage = AnthropicUsage.model_validate(usage_data)
            return UsageInfo.from_anthropic_usage(anthropic_usage)
        except Exception:
            # Fall back to direct conversion
            return UsageInfo(
                input_tokens=getattr(usage_data, "input_tokens", None),
                cache_creation_input_tokens=getattr(
                    usage_data, "cache_creation_input_tokens", None
                ),
                cache_read_input_tokens=getattr(
                    usage_data, "cache_read_input_tokens", None
                ),
                output_tokens=getattr(usage_data, "output_tokens", None),
                service_tier=getattr(usage_data, "service_tier", None),
                server_tool_use=getattr(usage_data, "server_tool_use", None),
            )

    # If it's a dict, validate and convert to our format
    if isinstance(usage_data, dict):
        return UsageInfo.model_validate(usage_data)

    return None


def parse_content_item(item_data: Dict[str, Any]) -> ContentItem:
    """Parse a content item using enhanced approach with Anthropic types."""
    try:
        content_type = item_data.get("type", "")

        # Try official Anthropic types first for better future compatibility
        if content_type == "text":
            try:
                from anthropic.types.text_block import TextBlock

                return TextBlock.model_validate(item_data)
            except Exception:
                return TextContent.model_validate(item_data)
        elif content_type == "tool_use":
            try:
                from anthropic.types.tool_use_block import ToolUseBlock

                return ToolUseBlock.model_validate(item_data)
            except Exception:
                return ToolUseContent.model_validate(item_data)
        elif content_type == "thinking":
            try:
                from anthropic.types.thinking_block import ThinkingBlock

                return ThinkingBlock.model_validate(item_data)
            except Exception:
                return ThinkingContent.model_validate(item_data)
        elif content_type == "tool_result":
            return ToolResultContent.model_validate(item_data)
        elif content_type == "image":
            return ImageContent.model_validate(item_data)
        else:
            # Fallback to text content for unknown types
            return TextContent(type="text", text=str(item_data))
    except Exception:
        return TextContent(type="text", text=str(item_data))


def parse_message_content(content_data: Any) -> Union[str, List[ContentItem]]:
    """Parse message content, handling both string and list formats."""
    if isinstance(content_data, str):
        return content_data
    elif isinstance(content_data, list):
        content_list = cast(List[Dict[str, Any]], content_data)
        return [parse_content_item(item) for item in content_list]
    else:
        return str(content_data)


def parse_transcript_entry(data: Dict[str, Any]) -> TranscriptEntry:
    """
    Parse a JSON dictionary into the appropriate TranscriptEntry type.

    Enhanced to optionally use official Anthropic types for assistant messages.

    Args:
        data: Dictionary parsed from JSON

    Returns:
        The appropriate TranscriptEntry subclass

    Raises:
        ValueError: If the data doesn't match any known transcript entry type
    """
    entry_type = data.get("type")

    if entry_type == "user":
        # Parse message content if present
        data_copy = data.copy()
        if "message" in data_copy and "content" in data_copy["message"]:
            data_copy["message"] = data_copy["message"].copy()
            data_copy["message"]["content"] = parse_message_content(
                data_copy["message"]["content"]
            )
        # Parse toolUseResult if present and it's a list of content items
        if "toolUseResult" in data_copy and isinstance(
            data_copy["toolUseResult"], list
        ):
            # Check if it's a list of content items (MCP tool results)
            tool_use_result = cast(List[Any], data_copy["toolUseResult"])
            if (
                tool_use_result
                and isinstance(tool_use_result[0], dict)
                and "type" in tool_use_result[0]
            ):
                data_copy["toolUseResult"] = [
                    parse_content_item(cast(Dict[str, Any], item))
                    for item in tool_use_result
                    if isinstance(item, dict)
                ]
        return UserTranscriptEntry.model_validate(data_copy)

    elif entry_type == "assistant":
        # Enhanced assistant message parsing with optional Anthropic types
        data_copy = data.copy()

        # Validate compatibility with official Anthropic Message type
        if "message" in data_copy:
            try:
                message_data = data_copy["message"]
                AnthropicMessage.model_validate(message_data)
                # Successfully validated - our data is compatible with official Anthropic types
            except Exception:
                # Validation failed - continue with standard parsing
                pass

        # Standard parsing path (works for all cases)
        if "message" in data_copy and "content" in data_copy["message"]:
            message_copy = data_copy["message"].copy()
            message_copy["content"] = parse_message_content(message_copy["content"])

            # Normalize usage data to support both Anthropic and custom formats
            if "usage" in message_copy:
                message_copy["usage"] = normalize_usage_info(message_copy["usage"])

            data_copy["message"] = message_copy
        return AssistantTranscriptEntry.model_validate(data_copy)

    elif entry_type == "summary":
        return SummaryTranscriptEntry.model_validate(data)

    elif entry_type == "system":
        return SystemTranscriptEntry.model_validate(data)

    elif entry_type == "queue-operation":
        # Parse content if present (only in enqueue operations)
        data_copy = data.copy()
        if "content" in data_copy and isinstance(data_copy["content"], list):
            data_copy["content"] = parse_message_content(data_copy["content"])
        return QueueOperationTranscriptEntry.model_validate(data_copy)

    else:
        raise ValueError(f"Unknown transcript entry type: {entry_type}")