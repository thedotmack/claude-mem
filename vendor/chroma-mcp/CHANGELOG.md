# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.6] - 08/14/2025

- Update chromadb to 1.0.16
- Add tool prompts for regex support
- Add new `chroma_fork_collection` tool support

## [0.2.5] - 06/18/2025

- Update chromadb to 1.0.13
- Simplify configuration instantiation
- Clarify list_collection success with no collections
- Remove Optional parameters, replace with | None

## [0.2.4] - 05/21/2025

### Changed

- Update chromadb to v1.0.10

## [0.2.2] - 04/08/2025

### Changed

- Update chromadb to v1.0.3
- Fix include on query and get to match chromadb Python client


## [0.2.1] - 04/03/2025

### Added

- The ability to select embedding functions when creating collections (default, cohere, openai, jina, voyageai, roboflow)

### Changed
- Upgraded to v1.0.0 of Chroma
- Fix dotenv path support during argparse

## [0.2.0] - 04/02/2025

### Added
- New `delete_document` tool for removing documents from collections
- New `chroma_update_documents` tool for updating existing documents
- Docker deployment support with Dockerfile
- Smithery configuration for deployment
- Environment variable support in Smithery config

### Changed
- Improved error handling across tools
- Removed sequential thinking in favor of more direct operations
- SSL parsing improvements and fixes

### Security
- Enhanced SSL handling and security configurations

## [0.1.11] - 02/21/2025

### Changed
- Version bump

## [0.1.10] - 02/21/2024

### Added
- Initial release
- Support for ephemeral, persistent, HTTP, and cloud Chroma clients
- Collection management tools
- Document operations (add, query, get)
- Claude Desktop integration
- Environment variable support
- Dotenv file support

### Security
- SSL support for HTTP and cloud clients
- Authentication support for HTTP clients
- API key management for cloud deployments 