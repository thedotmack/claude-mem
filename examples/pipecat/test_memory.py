import asyncio
import unittest
from contextlib import asynccontextmanager
import json
from unittest.mock import AsyncMock, patch

from mcp.types import CallToolResult, TextContent

from pipecat.frames.frames import EndFrame, InputAudioRawFrame, TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import WorkerRunner
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor

from memory import MemoryResultFrame, ProjectMemory, RecallMemoryFrame, SaveMemoryFrame, execute_memory


class Collector(FrameProcessor):
    def __init__(self):
        super().__init__()
        self.frames = []

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        self.frames.append(frame)
        await self.push_frame(frame, direction)


async def run_pipeline(frames, *, enabled=True):
    collector = Collector()
    memory = ProjectMemory("voice-demo", "/unused/mcp-server.cjs", "/unused", enabled=enabled)
    worker = PipelineWorker(Pipeline([memory, collector]), enable_rtvi=False, enable_turn_tracking=False)
    await worker.queue_frames([*frames, EndFrame()])
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await asyncio.wait_for(runner.run(), timeout=5)
    return collector.frames


class MemoryPipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_audio_and_transcripts_are_not_saved(self):
        audio = InputAudioRawFrame(audio=b"\0" * 320, sample_rate=16000, num_channels=1)
        transcript = TranscriptionFrame("Please remember everything", "speaker", "2026-11-12T00:00:00Z")
        with patch("memory.execute_memory", new_callable=AsyncMock) as execute:
            frames = await run_pipeline([audio, transcript])
        execute.assert_not_awaited()
        self.assertIn(audio, frames)
        self.assertIn(transcript, frames)

    async def test_only_explicit_save_and_recall_frames_invoke_memory(self):
        save = SaveMemoryFrame(text="Use the amber staging region.", title="Deployment decision")
        recall = RecallMemoryFrame(query="Deployment decision", observation_id=42)
        with patch("memory.execute_memory", new_callable=AsyncMock, side_effect=["Saved memory #42.", "Use the amber staging region."]) as execute:
            frames = await run_pipeline([save, recall])
        self.assertEqual(execute.await_count, 2)
        self.assertEqual(execute.await_args_list[0].args[0], "voice-demo")
        self.assertIs(execute.await_args_list[0].args[1], save)
        results = [frame for frame in frames if isinstance(frame, MemoryResultFrame)]
        self.assertEqual([frame.success for frame in results], [True, True])
        self.assertIn("amber", results[1].text)

    async def test_memory_failure_is_reported_and_later_audio_keeps_flowing(self):
        audio = InputAudioRawFrame(audio=b"\0" * 320, sample_rate=16000, num_channels=1)
        with patch("memory.execute_memory", new_callable=AsyncMock, side_effect=TimeoutError("PRIVATE_PAYLOAD")):
            frames = await run_pipeline([SaveMemoryFrame(text="Selected text"), audio])
        results = [frame for frame in frames if isinstance(frame, MemoryResultFrame)]
        self.assertEqual(len(results), 1)
        self.assertFalse(results[0].success)
        self.assertNotIn("PRIVATE_PAYLOAD", results[0].text)
        self.assertIn(audio, frames)

    async def test_disabled_memory_does_not_connect(self):
        with patch("memory.execute_memory", new_callable=AsyncMock) as execute:
            frames = await run_pipeline([SaveMemoryFrame(text="Selected text")], enabled=False)
        execute.assert_not_awaited()
        self.assertFalse(next(frame for frame in frames if isinstance(frame, MemoryResultFrame)).success)


class MemoryOperationTests(unittest.IsolatedAsyncioTestCase):
    async def test_selected_reads_keep_one_literal_project_on_every_request(self):
        session = type("Session", (), {"call_tool": AsyncMock(return_value=CallToolResult(content=[TextContent(type="text", text="#42 — selected note")]))})()

        @asynccontextmanager
        async def connected(*args):
            yield session

        with patch("memory.memory_session", connected):
            await execute_memory(" voice,project ", RecallMemoryFrame(query="decision", observation_id=42), "unused", "unused")
        self.assertEqual([call.args[0] for call in session.call_tool.await_args_list], ["search", "timeline", "get_observations"])
        for call in session.call_tool.await_args_list:
            self.assertEqual(call.kwargs["arguments"]["project"], " voice,project ")
            self.assertEqual(json.loads(call.kwargs["arguments"]["projects"]), [" voice,project "])

    async def test_repeated_selected_text_gets_the_same_deduplication_key(self):
        session = type("Session", (), {"call_tool": AsyncMock(return_value=CallToolResult(content=[TextContent(type="text", text="Saved memory #42: decision.")]))})()

        @asynccontextmanager
        async def connected(*args):
            yield session

        with patch("memory.memory_session", connected):
            for text in [" chosen text ", "chosen text"]:
                await execute_memory("voice-demo", SaveMemoryFrame(text=text), "unused", "unused")
        metadata = [call.kwargs["arguments"]["metadata"] for call in session.call_tool.await_args_list]
        self.assertEqual(metadata[0], metadata[1])
        self.assertEqual(metadata[0]["platformSource"], "pipecat")

    async def test_mcp_error_is_not_treated_as_a_successful_read(self):
        session = type("Session", (), {"call_tool": AsyncMock(return_value=CallToolResult(is_error=True, content=[TextContent(type="text", text="PRIVATE_FAILURE")]))})()

        @asynccontextmanager
        async def connected(*args):
            yield session

        with patch("memory.memory_session", connected), self.assertRaisesRegex(RuntimeError, "reported a failure"):
            await execute_memory("voice-demo", RecallMemoryFrame(query="decision", observation_id=42), "unused", "unused")
        self.assertEqual(session.call_tool.await_count, 1)


if __name__ == "__main__":
    unittest.main()
