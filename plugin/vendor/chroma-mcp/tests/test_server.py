import pytest
from chroma_mcp.server import get_chroma_client, create_parser, mcp
import chromadb
import sys
import os
from unittest.mock import patch, MagicMock
import argparse
from mcp.server.fastmcp.exceptions import ToolError # Import ToolError
import json # Import json for parsing results


# Add pytest-asyncio marker
pytest_plugins = ['pytest_asyncio']

@pytest.fixture(autouse=True)
def setup_test_args():
    # Modify sys.argv to provide the required arguments for all tests
    original_argv = sys.argv.copy()
    sys.argv = ['chroma-mcp', '--client-type', 'ephemeral']
    yield
    sys.argv = original_argv

@pytest.fixture
def mock_env_vars():
    """Fixture to mock environment variables and clean them up after tests."""
    original_environ = os.environ.copy()
    yield
    os.environ.clear()
    os.environ.update(original_environ)

def test_get_chroma_client_ephemeral():
    # Test ephemeral client creation
    client = get_chroma_client()
    assert isinstance(client, chromadb.ClientAPI)

@pytest.mark.asyncio
async def test_list_collections():
    # Test list_collections tool
    result = await mcp.call_tool("chroma_list_collections", {"limit": 50, "offset": 0})
    assert isinstance(result, list)

@pytest.mark.asyncio
async def test_create_and_delete_collection():
    # Test collection creation and deletion
    collection_name = "test_collection"
    
    # Create collection
    create_result = await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
    assert len(create_result) == 1  # Should return a list with one TextContent
    assert "Successfully created collection" in create_result[0].text
    
    # Delete collection
    delete_result = await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})
    assert len(delete_result) == 1  # Should return a list with one TextContent
    assert "Successfully deleted collection" in delete_result[0].text

# New tests for argument parsing

def test_create_parser_defaults():
    """Test that the parser creates default values correctly."""
    parser = create_parser()
    args = parser.parse_args(['--client-type', 'ephemeral'])
    
    # Check default values
    assert args.client_type == 'ephemeral'
    assert args.ssl is True  # Default should be True
    assert args.dotenv_path == '.chroma_env'

def test_create_parser_all_args():
    """Test that the parser handles all arguments correctly."""
    parser = create_parser()
    args = parser.parse_args([
        '--client-type', 'http',
        '--host', 'test-host',
        '--port', '8080',
        '--ssl', 'false',
        '--dotenv-path', 'custom.env'
    ])
    
    # Check parsed values
    assert args.client_type == 'http'
    assert args.host == 'test-host'
    assert args.port == '8080'
    assert args.ssl is False
    assert args.dotenv_path == 'custom.env'

def test_create_parser_boolean_args():
    """Test that boolean arguments are parsed correctly with different formats."""
    parser = create_parser()
    
    # Test various true values
    for true_val in ['true', 'yes', '1', 't', 'y', 'True', 'YES']:
        args = parser.parse_args(['--client-type', 'ephemeral', '--ssl', true_val])
        assert args.ssl is True, f"Failed for value: {true_val}"
    
    # Test various false values
    for false_val in ['false', 'no', '0', 'f', 'n', 'False', 'NO']:
        args = parser.parse_args(['--client-type', 'ephemeral', '--ssl', false_val])
        assert args.ssl is False, f"Failed for value: {false_val}"

@patch.dict(os.environ, {
    'CHROMA_CLIENT_TYPE': 'http',
    'CHROMA_HOST': 'env-host',
    'CHROMA_PORT': '9090',
    'CHROMA_SSL': 'false'
})
def test_env_vars_override_defaults():
    """Test that environment variables override default values."""
    parser = create_parser()
    args = parser.parse_args([])  # No command line args
    
    # Environment variables should be used
    assert args.client_type == 'http'
    assert args.host == 'env-host'
    assert args.port == '9090'
    assert args.ssl is False

def test_cmd_args_override_env_vars(mock_env_vars):
    """Test that command line arguments override environment variables."""
    # Set environment variables
    os.environ['CHROMA_CLIENT_TYPE'] = 'http'
    os.environ['CHROMA_HOST'] = 'env-host'
    os.environ['CHROMA_SSL'] = 'false'
    
    parser = create_parser()
    # Override with command line args
    args = parser.parse_args([
        '--client-type', 'persistent',
        '--data-dir', '/test/dir',
        '--ssl', 'true'
    ])
    
    # Command line args should take precedence
    assert args.client_type == 'persistent'
    assert args.data_dir == '/test/dir'
    assert args.ssl is True
    # But other env vars should still be used
    assert args.host == 'env-host'

@patch('chroma_mcp.server._chroma_client', None)  # Reset the global client
@patch('chromadb.HttpClient')
def test_http_client_creation(mock_http_client, mock_env_vars):
    """Test HTTP client creation with various arguments."""
    mock_instance = MagicMock()
    mock_http_client.return_value = mock_instance
    
    # Set up command line args
    sys.argv = ['chroma-mcp', 
                '--client-type', 'http',
                '--host', 'test-host',
                '--port', '8080',
                '--ssl', 'false']
    
    client = get_chroma_client()
    
    # Check that HttpClient was called with correct args
    mock_http_client.assert_called_once()
    call_kwargs = mock_http_client.call_args.kwargs
    assert call_kwargs['host'] == 'test-host'
    assert call_kwargs['port'] == '8080'
    assert call_kwargs['ssl'] is False

@patch('chroma_mcp.server._chroma_client', None)  # Reset the global client
@patch('chromadb.HttpClient')
def test_cloud_client_creation(mock_http_client, mock_env_vars):
    """Test cloud client creation with various arguments."""
    mock_instance = MagicMock()
    mock_http_client.return_value = mock_instance
    
    # Set up command line args
    sys.argv = ['chroma-mcp', 
                '--client-type', 'cloud',
                '--tenant', 'test-tenant',
                '--database', 'test-db',
                '--api-key', 'test-api-key']
    
    client = get_chroma_client()
    
    # Check that HttpClient was called with correct args
    mock_http_client.assert_called_once()
    call_kwargs = mock_http_client.call_args.kwargs
    assert call_kwargs['host'] == 'api.trychroma.com'
    assert call_kwargs['ssl'] is True  # Always true for cloud
    assert call_kwargs['tenant'] == 'test-tenant'
    assert call_kwargs['database'] == 'test-db'
    assert call_kwargs['headers'] == {'x-chroma-token': 'test-api-key'}

@patch('chroma_mcp.server._chroma_client', None)  # Reset the global client
@patch('chromadb.PersistentClient')
def test_persistent_client_creation(mock_persistent_client, mock_env_vars):
    """Test persistent client creation."""
    mock_instance = MagicMock()
    mock_persistent_client.return_value = mock_instance
    
    # Set up command line args
    sys.argv = ['chroma-mcp', 
                '--client-type', 'persistent',
                '--data-dir', '/test/data/dir']
    
    client = get_chroma_client()
    
    # Check that PersistentClient was called with correct args
    mock_persistent_client.assert_called_once_with(path='/test/data/dir')

@patch('chroma_mcp.server._chroma_client', None)  # Reset the global client
@patch('chromadb.EphemeralClient')
def test_ephemeral_client_creation(mock_ephemeral_client, mock_env_vars):
    """Test ephemeral client creation."""
    mock_instance = MagicMock()
    mock_ephemeral_client.return_value = mock_instance
    
    # Set up command line args
    sys.argv = ['chroma-mcp', '--client-type', 'ephemeral']
    
    client = get_chroma_client()
    
    # Check that EphemeralClient was called
    mock_ephemeral_client.assert_called_once()

def test_client_type_validation():
    """Test validation of client type argument."""
    parser = create_parser()
    
    # Valid client types
    for valid_type in ['http', 'cloud', 'persistent', 'ephemeral']:
        args = parser.parse_args(['--client-type', valid_type])
        assert args.client_type == valid_type
    
    # Invalid client type
    with pytest.raises(SystemExit):
        parser.parse_args(['--client-type', 'invalid'])

def test_required_args_for_http_client():
    """Test that required arguments are enforced for HTTP client."""
    with patch('argparse.ArgumentParser.error') as mock_error:
        from chroma_mcp.server import main
        
        # Set up command line args without required host
        sys.argv = ['chroma-mcp', '--client-type', 'http']
        
        try:
            main()
        except:
            pass
        
        # Check that error was called for missing host
        mock_error.assert_called_with(
            "Host must be provided via --host flag or CHROMA_HOST environment variable when using HTTP client"
        )

def test_required_args_for_cloud_client():
    """Test that required arguments are enforced for cloud client."""
    with patch('argparse.ArgumentParser.error') as mock_error:
        from chroma_mcp.server import main
        
        # Set up command line args without required tenant/database/api-key
        sys.argv = ['chroma-mcp', '--client-type', 'cloud']
        
        try:
            main()
        except:
            pass
        
        # Check that error was called for missing api-key (the first check in the code)
        mock_error.assert_called_with(
            "API key must be provided via --api-key flag or CHROMA_API_KEY environment variable when using cloud client"
        )

# --- Tests for chroma_update_documents ---

@pytest.mark.asyncio
async def test_update_documents_success():
    """Test successful document update."""
    collection_name = "test_update_collection_success"
    doc_ids = ["doc1", "doc2"]
    initial_docs = ["Initial doc 1", "Initial doc 2"]
    initial_metadatas = [{"source": "initial"}, {"source": "initial"}]
    updated_docs = ["Updated doc 1", initial_docs[1]] # Update only first doc content
    updated_metadatas = [initial_metadatas[0], {"source": "updated"}] # Update only second doc metadata

    try:
        # 1. Create collection
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})

        # 2. Add initial documents
        await mcp.call_tool("chroma_add_documents", {
            "collection_name": collection_name,
            "documents": initial_docs,
            "metadatas": initial_metadatas,
            "ids": doc_ids
        })

        # 3. Update documents (pass both documents and metadatas)
        update_result = await mcp.call_tool("chroma_update_documents", {
            "collection_name": collection_name,
            "ids": doc_ids,
            "documents": updated_docs,
            "metadatas": updated_metadatas
        })
        assert len(update_result) == 1
        # Updated success message check
        assert (
            f"Successfully processed update request for {len(doc_ids)} documents"
            in update_result[0].text
        )

        # 4. Verify updates
        get_result_raw = await mcp.call_tool("chroma_get_documents", {
            "collection_name": collection_name,
            "ids": doc_ids,
            "include": ["documents", "metadatas"]
        })
        # Corrected: Parse the JSON string from TextContent
        assert len(get_result_raw) == 1
        get_result = json.loads(get_result_raw[0].text)
        assert isinstance(get_result, dict)

        assert get_result.get("ids") == doc_ids
        # Check updated document content
        assert get_result.get("documents") == updated_docs
        # Check updated metadata
        assert get_result.get("metadatas") == updated_metadatas

    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_update_documents_invalid_args():
    """Test update documents with invalid arguments."""
    collection_name = "test_update_collection_invalid"

    try:
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        await mcp.call_tool("chroma_add_documents", {
            "collection_name": collection_name,
            "documents": ["Test doc"],
            "ids": ["doc1"]
        })

        # Test with empty IDs list - Expect ToolError wrapping ValueError
        with pytest.raises(ToolError, match="The 'ids' list cannot be empty."):
            await mcp.call_tool("chroma_update_documents", {
                "collection_name": collection_name,
                "ids": [],
                "documents": ["New content"]
            })

        # Test with no update fields provided - Expect ToolError wrapping ValueError
        with pytest.raises(
            ToolError,
            match="At least one of 'embeddings', 'metadatas', or 'documents' must be provided"
        ):
            await mcp.call_tool("chroma_update_documents", {
                "collection_name": collection_name,
                "ids": ["doc1"]
                # No embeddings, metadatas, or documents
            })

    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_update_documents_collection_not_found():
    """Test updating documents in a non-existent collection."""
    # Expect ToolError wrapping the Exception from the function
    with pytest.raises(ToolError, match="Failed to get collection"):
        await mcp.call_tool("chroma_update_documents", {
            "collection_name": "non_existent_collection",
            "ids": ["doc1"],
            "documents": ["New content"]
        })

@pytest.mark.asyncio
async def test_update_documents_id_not_found():
    """Test updating a document with an ID that does not exist. Expect no exception."""
    collection_name = "test_update_id_not_found"
    try:
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        await mcp.call_tool("chroma_add_documents", {
            "collection_name": collection_name,
            "documents": ["Test doc"],
            "ids": ["existing_id"]
        })

        # Attempt to update a non-existent ID - should not raise Exception
        update_result = await mcp.call_tool("chroma_update_documents", {
            "collection_name": collection_name,
            "ids": ["non_existent_id"],
            "documents": ["New content"]
        })
        # Check the success message (even though the ID didn't exist)
        assert len(update_result) == 1
        assert "Successfully processed update request" in update_result[0].text

        # Optionally, verify that the existing document was not changed
        get_result_raw = await mcp.call_tool("chroma_get_documents", {
            "collection_name": collection_name,
            "ids": ["existing_id"],
            "include": ["documents"]
        })
        # Corrected assertion: Parse JSON and check structure/content
        assert len(get_result_raw) == 1
        get_result = json.loads(get_result_raw[0].text)
        assert isinstance(get_result, dict)
        assert "documents" in get_result
        assert isinstance(get_result["documents"], list)
        assert get_result["documents"] == ["Test doc"]

    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

# --- Tests for chroma_delete_documents ---

@pytest.mark.asyncio
async def test_delete_documents_success():
    """Test successful document deletion."""
    collection_name = "test_delete_collection_success"
    doc_ids = ["doc1", "doc2"]
    docs = ["Test doc 1", "Test doc 2"]
    metadatas = [{"source": "test1"}, {"source": "test2"}]

    try:
        # 1. Create collection and add documents
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        await mcp.call_tool("chroma_add_documents", {
            "collection_name": collection_name,
            "documents": docs,
            "metadatas": metadatas,
            "ids": doc_ids
        })

        # 2. Delete documents
        delete_result = await mcp.call_tool("chroma_delete_documents", {
            "collection_name": collection_name,
            "ids": doc_ids
        })
        assert len(delete_result) == 1
        assert "Successfully deleted" in delete_result[0].text

        # 3. Verify documents are deleted
        get_result_raw = await mcp.call_tool("chroma_get_documents", {
            "collection_name": collection_name,
            "ids": doc_ids,
            "include": ["documents"]
        })
        assert len(get_result_raw) == 1
        get_result = json.loads(get_result_raw[0].text)
        assert isinstance(get_result, dict)
        assert not get_result.get("documents")

    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_delete_documents_invalid_args():
    """Test delete documents with invalid arguments."""
    collection_name = "test_delete_collection_invalid"

    try:
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        await mcp.call_tool("chroma_add_documents", {
            "collection_name": collection_name,
            "documents": ["Test doc"],
            "ids": ["doc1"]
        })

        # Test with empty IDs list - Expect ToolError wrapping ValueError
        with pytest.raises(ToolError, match="The 'ids' list cannot be empty."):
            await mcp.call_tool("chroma_delete_documents", {
                "collection_name": collection_name,
                "ids": []
            })

    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_delete_documents_collection_not_found():
    """Test deleting documents from a non-existent collection."""
    # Expect ToolError wrapping the Exception from the function
    with pytest.raises(ToolError, match="Failed to get collection"):
        await mcp.call_tool("chroma_delete_documents", {
            "collection_name": "non_existent_collection",
            "ids": ["doc1"]
        })

@pytest.mark.asyncio
async def test_delete_documents_id_not_found():
    """Test deleting a document with an ID that does not exist. Expect no exception."""
    collection_name = "test_delete_id_not_found"
    try:
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        await mcp.call_tool("chroma_add_documents", {
            "collection_name": collection_name,
            "documents": ["Test doc"],
            "ids": ["existing_id"]
        })

        # Attempt to delete a non-existent ID - should not raise Exception
        delete_result = await mcp.call_tool("chroma_delete_documents", {
            "collection_name": collection_name,
            "ids": ["non_existent_id"]
        })
        # Check the success message (even though the ID didn't exist)
        assert len(delete_result) == 1
        assert "Successfully deleted" in delete_result[0].text

        # Verify that the existing document was not deleted
        get_result_raw = await mcp.call_tool("chroma_get_documents", {
            "collection_name": collection_name,
            "ids": ["existing_id"],
            "include": ["documents"]
        })
        assert len(get_result_raw) == 1
        get_result = json.loads(get_result_raw[0].text)
        assert isinstance(get_result, dict)
        assert "documents" in get_result
        assert isinstance(get_result["documents"], list)
        assert get_result["documents"] == ["Test doc"]

    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

# --- Tests for Collection Tools ---

@pytest.mark.asyncio
async def test_list_collections_success():
    """Test successful collection listing."""
    collection_name = "test_list_collections"
    try:
        # Create a test collection
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        
        # List collections
        result = await mcp.call_tool("chroma_list_collections", {"limit": 50, "offset": 0})
        assert isinstance(result, list)
        assert any(collection_name in item.text for item in result)
        
        # Test with limit
        limited_result = await mcp.call_tool("chroma_list_collections", {"limit": 1, "offset": 0})
        assert isinstance(limited_result, list)
        assert len(limited_result) <= 1
        
    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_create_collection_success():
    """Test successful collection creation with various configurations."""
    collection_name = "test_create_collection"
    try:
        # Test basic creation
        result = await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        assert "Successfully created collection" in result[0].text

        # Test creation with HNSW configuration
        hnsw_collection = "test_hnsw_collection"
        hnsw_params = {
            "collection_name": hnsw_collection,
        }
        hnsw_result = await mcp.call_tool("chroma_create_collection", hnsw_params)
        assert "Successfully created collection" in hnsw_result[0].text

    finally:
        # Cleanup: delete the collections if they exist
        try:
            await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})
        except Exception:
            pass
        try:
            await mcp.call_tool("chroma_delete_collection", {"collection_name": hnsw_collection})
        except Exception:
            pass

@pytest.mark.asyncio
async def test_create_collection_duplicate():
    """Test creating a collection with a name that already exists."""
    collection_name = "test_duplicate_collection"
    try:
        # Create initial collection
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        
        # Attempt to create duplicate
        with pytest.raises(ToolError, match="Failed to create collection"):
            await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
            
    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_peek_collection_success():
    """Test successful collection peeking."""
    collection_name = "test_peek_collection"
    try:
        # Create collection and add documents
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        await mcp.call_tool("chroma_add_documents", {
            "collection_name": collection_name,
            "documents": ["Test doc 1", "Test doc 2", "Test doc 3"],
            "ids": ["doc1", "doc2", "doc3"]
        })
        
        # Test peek with default limit
        result = await mcp.call_tool("chroma_peek_collection", {"collection_name": collection_name})
        assert isinstance(result, list)
        assert len(result) == 1
        assert "documents" in result[0].text
        assert "ids" in result[0].text
        assert "metadatas" in result[0].text
        
        # Test peek with custom limit
        limited_result = await mcp.call_tool("chroma_peek_collection", {
            "collection_name": collection_name,
            "limit": 2
        })
        assert len(limited_result) == 1
        assert "documents" in limited_result[0].text
        assert "ids" in limited_result[0].text
        assert "metadatas" in limited_result[0].text
        
    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_get_collection_info_success():
    """Test successful collection info retrieval."""
    collection_name = "test_collection_info"
    try:
        # Create collection and add documents
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        await mcp.call_tool("chroma_add_documents", {
            "collection_name": collection_name,
            "documents": ["Test doc 1", "Test doc 2", "Test doc 3"],
            "ids": ["doc1", "doc2", "doc3"]
        })
        
        # Get collection info
        result = await mcp.call_tool("chroma_get_collection_info", {"collection_name": collection_name})
        assert isinstance(result, list)
        assert len(result) == 1
        assert collection_name in result[0].text
        assert "count" in result[0].text
        assert "sample_documents" in result[0].text
        
    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_get_collection_count_success():
    """Test successful collection count retrieval."""
    collection_name = "test_collection_count"
    try:
        # Create collection and add documents
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        await mcp.call_tool("chroma_add_documents", {
            "collection_name": collection_name,
            "documents": ["Test doc 1", "Test doc 2", "Test doc 3"],
            "ids": ["doc1", "doc2", "doc3"]
        })
        
        # Get collection count
        result = await mcp.call_tool("chroma_get_collection_count", {"collection_name": collection_name})
        assert isinstance(result, list)
        assert len(result) == 1
        count = int(result[0].text)
        assert count == 3
        
    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_modify_collection_success():
    """Test successful collection modification."""
    collection_name = "test_modify_collection"
    new_name = "test_modified_collection"
    try:
        # Create initial collection
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        
        # Test modifying name
        name_result = await mcp.call_tool("chroma_modify_collection", {
            "collection_name": collection_name,
            "new_name": new_name
        })
        assert "Successfully modified collection" in name_result[0].text
        assert "updated name" in name_result[0].text
        
        # Test modifying metadata
        metadata_result = await mcp.call_tool("chroma_modify_collection", {
            "collection_name": new_name,
            "new_metadata": {"test_key": "test_value"}
        })
        assert "Successfully modified collection" in metadata_result[0].text
        assert "updated metadata" in metadata_result[0].text
        
    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": new_name})

@pytest.mark.asyncio
async def test_delete_collection_success():
    """Test successful collection deletion."""
    collection_name = "test_delete_collection"
    try:
        # Create collection
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        
        # Delete collection
        result = await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})
        assert "Successfully deleted collection" in result[0].text
        
        # Verify collection is deleted
        with pytest.raises(ToolError, match="Failed to get collection"):
            await mcp.call_tool("chroma_get_collection_info", {"collection_name": collection_name})
            
    finally:
        # Clean up in case deletion failed
        try:
            await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})
        except:
            pass

# --- Tests for Document Tools ---

@pytest.mark.asyncio
async def test_add_documents_success():
    """Test successful document addition."""
    collection_name = "test_add_documents"
    try:
        # Create collection
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        
        # Test adding documents with metadata
        result = await mcp.call_tool("chroma_add_documents", {
            "collection_name": collection_name,
            "documents": ["Test doc 1", "Test doc 2"],
            "metadatas": [{"source": "test1"}, {"source": "test2"}],
            "ids": ["doc1", "doc2"]
        })
        assert "Successfully added" in result[0].text
        
        # Verify documents were added
        get_result = await mcp.call_tool("chroma_get_documents", {
            "collection_name": collection_name,
            "ids": ["doc1", "doc2"],
            "include": ["documents", "metadatas"]
        })
        get_data = json.loads(get_result[0].text)
        assert len(get_data["documents"]) == 2
        assert len(get_data["metadatas"]) == 2
        
    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_add_documents_invalid_args():
    """Test adding documents with invalid arguments."""
    collection_name = "test_add_documents_invalid"
    try:
        # Create collection
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        
        # Test with empty documents list
        with pytest.raises(ToolError, match="The 'documents' list cannot be empty"):
            await mcp.call_tool("chroma_add_documents", {
                "collection_name": collection_name,
                "documents": [],
                "ids": ["doc1"]
            })
            
    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_query_documents_success():
    """Test successful document querying."""
    collection_name = "test_query_documents"
    try:
        # Create collection and add documents
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        await mcp.call_tool("chroma_add_documents", {
            "collection_name": collection_name,
            "documents": ["Test doc 1", "Test doc 2", "Test doc 3"],
            "metadatas": [
                {"source": "test1", "category": "A"},
                {"source": "test2", "category": "B"},
                {"source": "test3", "category": "A"}
            ],
            "ids": ["doc1", "doc2", "doc3"]
        })
        
        # Test basic query
        query_result = await mcp.call_tool("chroma_query_documents", {
            "collection_name": collection_name,
            "query_texts": ["Test doc 1"],  # Use exact match for more reliable results
            "n_results": 2,
            "include": ["documents", "metadatas", "distances"]
        })
        assert isinstance(query_result, list)
        assert len(query_result) == 1
        assert "documents" in query_result[0].text
        assert "metadatas" in query_result[0].text
        assert "distances" in query_result[0].text
        
        # Test query with metadata filter
        filtered_result = await mcp.call_tool("chroma_query_documents", {
            "collection_name": collection_name,
            "query_texts": ["Test doc 1"],  # Use exact match for more reliable results
            "n_results": 2,
            "where": {"category": "A"},
            "include": ["documents", "metadatas", "distances"]
        })
        assert isinstance(filtered_result, list)
        assert len(filtered_result) == 1
        assert "documents" in filtered_result[0].text
        assert "metadatas" in filtered_result[0].text
        assert "distances" in filtered_result[0].text
        
    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_query_documents_invalid_args():
    """Test querying documents with invalid arguments."""
    collection_name = "test_query_documents_invalid"
    try:
        # Create collection
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        
        # Test with empty query_texts
        with pytest.raises(ToolError, match="The 'query_texts' list cannot be empty"):
            await mcp.call_tool("chroma_query_documents", {
                "collection_name": collection_name,
                "query_texts": [],
                "n_results": 5
            })
            
    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_get_documents_success():
    """Test successful document retrieval."""
    collection_name = "test_get_documents"
    try:
        # Create collection and add documents
        await mcp.call_tool("chroma_create_collection", {"collection_name": collection_name})
        await mcp.call_tool("chroma_add_documents", {
            "collection_name": collection_name,
            "documents": ["Test doc 1", "Test doc 2", "Test doc 3"],
            "metadatas": [
                {"source": "test1", "category": "A"},
                {"source": "test2", "category": "B"},
                {"source": "test3", "category": "A"}
            ],
            "ids": ["doc1", "doc2", "doc3"]
        })
        
        # Test getting by IDs
        id_result = await mcp.call_tool("chroma_get_documents", {
            "collection_name": collection_name,
            "ids": ["doc1", "doc2"],
            "include": ["documents", "metadatas"]
        })
        id_data = json.loads(id_result[0].text)
        assert len(id_data["documents"]) == 2
        
        # Test getting with metadata filter
        filter_result = await mcp.call_tool("chroma_get_documents", {
            "collection_name": collection_name,
            "where": {"category": "A"},
            "include": ["documents", "metadatas"]
        })
        filter_data = json.loads(filter_result[0].text)
        assert len(filter_data["documents"]) == 2
        
        # Test getting with limit and offset
        paginated_result = await mcp.call_tool("chroma_get_documents", {
            "collection_name": collection_name,
            "limit": 2,
            "offset": 1,
            "include": ["documents"]
        })
        paginated_data = json.loads(paginated_result[0].text)
        assert len(paginated_data["documents"]) == 2
        
    finally:
        # Clean up
        await mcp.call_tool("chroma_delete_collection", {"collection_name": collection_name})

@pytest.mark.asyncio
async def test_get_documents_collection_not_found():
    """Test getting documents from non-existent collection."""
    with pytest.raises(ToolError, match="Failed to get documents from collection"):
        await mcp.call_tool("chroma_get_documents", {
            "collection_name": "non_existent_collection",
            "ids": ["doc1"]
        })