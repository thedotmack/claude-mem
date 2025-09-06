### Team Knowledge Base Example

Let's say your team maintains a knowledge base of customer support interactions. By storing these in Chroma Cloud, team members can use Claude to quickly access and learn from past support cases.

First, set up your shared knowledge base:

```python
import chromadb
from datetime import datetime

# Connect to Chroma Cloud
client = chromadb.HttpClient(
    ssl=True,
    host='api.trychroma.com',
    tenant='your-tenant-id',
    database='support-kb',
    headers={
        'x-chroma-token': 'YOUR_API_KEY'
    }
)

# Create a collection for support cases
collection = client.create_collection("support_cases")

# Add some example support cases
support_cases = [
    {
        "case": "Customer reported issues connecting their IoT devices to the dashboard.",
        "resolution": "Guided customer through firewall configuration and port forwarding setup.",
        "category": "connectivity",
        "date": "2024-03-15"
    },
    {
        "case": "User couldn't access admin features after recent update.",
        "resolution": "Discovered role permissions weren't migrated correctly. Applied fix and documented process.",
        "category": "permissions",
        "date": "2024-03-16"
    }
]

# Add documents to collection
collection.add(
    documents=[case["case"] + "\n" + case["resolution"] for case in support_cases],
    metadatas=[{
        "category": case["category"],
        "date": case["date"]
    } for case in support_cases],
    ids=[f"case_{i}" for i in range(len(support_cases))]
)
```

Now team members can use Claude to access this knowledge.

In your claude config, add the following:
```json
{
  "mcpServers": {
    "chroma": {
      "command": "uvx",
      "args": [
        "chroma-mcp",
        "--client-type",
        "cloud",
        "--tenant",
        "your-tenant-id",
        "--database",
        "support-kb",
        "--api-key",
        "YOUR_API_KEY"
      ]
    }
  }
}
```

Now you can use the knowledge base in your chats:
```
Claude, I'm having trouble helping a customer with IoT device connectivity.
Can you check our support knowledge base for similar cases and suggest a solution?
```

Claude will:
1. Search the shared knowledge base for relevant cases
2. Consider the context and solutions from similar past issues
3. Provide recommendations based on previous successful resolutions

This setup is particularly powerful because:
- All support team members have access to the same knowledge base
- Claude can learn from the entire team's experience
- Solutions are standardized across the organization
- New team members can quickly get up to speed on common issues

