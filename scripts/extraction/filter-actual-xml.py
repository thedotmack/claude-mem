#!/usr/bin/env python3
import json
import re
from datetime import datetime
import os

def extract_xml_blocks(text):
    """Extract complete XML blocks from text"""
    xml_patterns = [
        r'<observation>.*?</observation>',
        r'<session_summary>.*?</session_summary>',
        r'<request>.*?</request>',
        r'<summary>.*?</summary>',
        r'<facts>.*?</facts>',
        r'<fact>.*?</fact>',
        r'<concepts>.*?</concepts>',
        r'<concept>.*?</concept>',
        r'<files>.*?</files>',
        r'<file>.*?</file>',
        r'<files_read>.*?</files_read>',
        r'<files_edited>.*?</files_edited>',
        r'<files_modified>.*?</files_modified>',
        r'<narrative>.*?</narrative>',
        r'<learned>.*?</learned>',
        r'<investigated>.*?</investigated>',
        r'<completed>.*?</completed>',
        r'<next_steps>.*?</next_steps>',
        r'<notes>.*?</notes>',
        r'<title>.*?</title>',
        r'<subtitle>.*?</subtitle>',
        r'<text>.*?</text>',
        r'<type>.*?</type>',
        r'<tool_used>.*?</tool_used>',
        r'<tool_name>.*?</tool_name>',
        r'<tool_input>.*?</tool_input>',
        r'<tool_output>.*?</tool_output>',
        r'<tool_time>.*?</tool_time>',
    ]

    blocks = []
    for pattern in xml_patterns:
        matches = re.findall(pattern, text, re.DOTALL)
        blocks.extend(matches)

    return blocks

def is_example_xml(xml_block):
    """Check if XML block is an example/template"""
    # Patterns that indicate this is example/template XML
    example_indicators = [
        r'\[.*?\]',  # Square brackets with placeholders
        r'\*\*\w+\*\*:',  # Bold markdown like **title**:
        r'\.\.\..*?\.\.\.',  # Ellipsis indicating placeholder
        r'feature\|bugfix\|refactor',  # Multiple options separated by |
        r'change \| discovery \| decision',  # Example types
        r'\{.*?\}',  # Curly braces (template variables)
        r'Concise, self-contained statement',  # Literal example text
        r'Short title capturing',
        r'One sentence explanation',
        r'What was the user trying',
        r'What code/systems did you explore',
        r'What did you learn',
        r'What was done',
        r'What should happen next',
        r'file1\.ts',  # Example filenames
        r'file2\.ts',
        r'file3\.ts',
        r'Any additional context',
    ]

    for pattern in example_indicators:
        if re.search(pattern, xml_block):
            return True

    return False

def process_transcript_file(filepath):
    """Process a single transcript file and extract only real XML from assistant responses"""
    results = []

    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        for line in f:
            try:
                data = json.loads(line)

                # Get timestamp
                timestamp = data.get('timestamp', 'unknown')

                # Only process assistant messages
                message = data.get('message', {})
                role = message.get('role')

                if role != 'assistant':
                    continue

                content = message.get('content', [])

                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and item.get('type') == 'text':
                            # This is text in an assistant response, not tool_use
                            text = item.get('text', '')

                            # Extract XML blocks
                            xml_blocks = extract_xml_blocks(text)

                            for block in xml_blocks:
                                # Filter out example/template XML
                                if not is_example_xml(block):
                                    results.append({
                                        'timestamp': timestamp,
                                        'xml': block
                                    })

            except json.JSONDecodeError:
                continue

    return results

# Get list of Oct 18 transcript files
import subprocess

transcript_dir = os.path.expanduser('~/.claude/projects/-Users-alexnewman-Scripts-claude-mem/')
os.chdir(transcript_dir)

# Get all transcript files sorted by modification time
result = subprocess.run(['ls', '-t'], capture_output=True, text=True)
files = [f for f in result.stdout.strip().split('\n') if f.endswith('.jsonl')][:62]

all_results = []
for filename in files:
    filepath = os.path.join(transcript_dir, filename)
    print(f"Processing {filename}...")
    results = process_transcript_file(filepath)
    all_results.extend(results)
    print(f"  Found {len(results)} actual XML blocks")

# Write results with timestamps
output_file = os.path.expanduser('~/Scripts/claude-mem/actual_xml_only_with_timestamps.xml')
with open(output_file, 'w', encoding='utf-8') as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
    f.write('<!-- Actual XML blocks from assistant responses only -->\n')
    f.write('<!-- Excludes: tool_use inputs, user prompts, and example/template XML -->\n')
    f.write('<transcript_extracts>\n\n')

    for i, item in enumerate(all_results, 1):
        timestamp = item['timestamp']
        xml = item['xml']

        # Format timestamp nicely if it's ISO format
        if timestamp != 'unknown' and timestamp:
            try:
                dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                formatted_time = dt.strftime('%Y-%m-%d %H:%M:%S UTC')
            except:
                formatted_time = timestamp
        else:
            formatted_time = 'unknown'

        f.write(f'<!-- Block {i} | {formatted_time} -->\n')
        f.write(xml)
        f.write('\n\n')

    f.write('</transcript_extracts>\n')

print(f"\n{'='*80}")
print(f"Extracted {len(all_results)} actual XML blocks (filtered) to {output_file}")
print(f"{'='*80}")
