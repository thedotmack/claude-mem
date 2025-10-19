#!/usr/bin/env python3
import json
import re
from datetime import datetime
import os
import subprocess

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
    ]

    blocks = []
    for pattern in xml_patterns:
        matches = re.findall(pattern, text, re.DOTALL)
        blocks.extend(matches)

    return blocks

def process_transcript_file(filepath):
    """Process a single transcript file and extract XML with timestamps"""
    results = []

    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        for line in f:
            try:
                data = json.loads(line)

                # Get timestamp
                timestamp = data.get('timestamp', 'unknown')

                # Extract text content from message
                message = data.get('message', {})
                content = message.get('content', [])

                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict):
                            text = ''
                            if item.get('type') == 'text':
                                text = item.get('text', '')
                            elif item.get('type') == 'tool_use':
                                # Also check tool_use input fields
                                tool_input = item.get('input', {})
                                if isinstance(tool_input, dict):
                                    text = str(tool_input)

                            if text:
                                # Extract XML blocks
                                xml_blocks = extract_xml_blocks(text)

                                for block in xml_blocks:
                                    results.append({
                                        'timestamp': timestamp,
                                        'xml': block
                                    })

            except json.JSONDecodeError:
                continue

    return results

# Get list of transcript files
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
    print(f"  Found {len(results)} XML blocks")

# Write results with timestamps
output_file = os.path.expanduser('~/Scripts/claude-mem/all_xml_fragments_with_timestamps.xml')
with open(output_file, 'w', encoding='utf-8') as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
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

print(f"\nExtracted {len(all_results)} XML blocks with timestamps to {output_file}")
