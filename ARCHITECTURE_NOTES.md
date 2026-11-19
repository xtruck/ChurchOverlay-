# Architecture Notes for Proposed Features

This document contains architecture notes for features requested that are currently out-of-scope per ARCHITECTURE.md section 3. These notes follow the pattern established in ARCHITECTURE.md section 59.3.

## Note 1: Cloud Synchronization

### Why Requested
User requested cloud sync for configuration and session data across multiple installations.

### What This Would Require
1. **Backend infrastructure**: A hosted or self-hosted backend service
2. **Authentication system**: User accounts, login, session management
3. **Multi-tenant data isolation**: Separate data per user/church
4. **Network connectivity**: Always-on internet dependency
5. **Data model changes**: Configuration sync, session history sync
6. **Security**: TLS, encryption in transit, key management
7. **Conflict resolution**: Handle concurrent edits across devices

### Architectural Impact
**VIOLATES ARCHITECTURE.md section 3 and 59.1**: The architecture explicitly states "still a local, single-install Electron desktop app (no hosting, no multi-tenant account system)".

**Breaking Changes**:
- Requires moving from local-only to cloud-native architecture
- Requires adding authentication and account management
- Requires backend service deployment
- Changes the security model (from local to networked)
- Requires offline-first mode or requires always-on connectivity

### Recommendation
**REJECTED** - This fundamentally changes the architecture from a local desktop app to a cloud-hosted service. This should be a separate product with its own architecture, not a feature of the current local-first application.

---

## Note 2: Automatic OBS Control

### Why Requested
User requested automatic OBS scene switching and control via OBS WebSocket.

### What This Would Require
1. **OBS WebSocket client**: Connection to OBS WebSocket server
2. **Scene mapping**: Mapping verses/media to OBS scenes
3. **State synchronization**: Keeping ChurchOverlay and OBS in sync
4. **Error handling**: What happens when OBS is unreachable?
5. **Configuration**: OBS connection settings, scene mappings
6. **Security**: OBS WebSocket authentication (password/token)

### Architectural Impact
**IN SCOPE per ROADMAP.md but deferred**: This is listed in ROADMAP.md as explicitly out-of-scope for v1 but could be considered for Phase 2 with proper architecture review.

**Breaking Changes**:
- Adds new external dependency (OBS WebSocket)
- Adds network connectivity requirement
- Adds configuration complexity
- Changes from read-only overlay to two-way OBS communication
- Requires careful error handling when OBS is unavailable

### Recommendation
**DEFERRED TO PHASE 2** - This feature is architecturally possible but requires:
1. Dedicated architecture note in ARCHITECTURE.md
2. Clear separation of concerns (OBS client as separate module)
3. Fallback behavior when OBS is unavailable
4. Explicit operator control over when OBS automation is active
5. Security review of OBS WebSocket authentication

---

## Note 3: Verse Range Support

### Why Requested
User requested support for verse ranges (e.g., "John 3:16-18") instead of single verses only.

### What This Would Require
1. **Data model changes**: `VerseReference` to support ranges
2. **Detector changes**: Regex patterns to match ranges
3. **UI changes**: Display logic for multi-verse content
4. **Validation changes**: Known-valid index must validate ranges
5. **API changes**: Bible API must support range queries
6. **Overlay changes**: Layout for longer text

### Architectural Impact
**ARCHITECTURE.md section 13 states**: "v1 should preferably support one verse at a time unless the product requirements explicitly require ranges."

**Breaking Changes**:
- Changes core data model (`VerseReference`)
- Changes detector contract
- Changes validation logic
- Changes overlay rendering
- May exceed overlay space for long ranges
- Bible API may not support all ranges consistently

### Recommendation
**DEFERRED** - This is architecturally possible but requires:
1. Explicit product requirement confirming ranges are needed
2. Data model extension with backward compatibility
3. Bible API compatibility verification (all ranges returnable?)
4. Overlay layout strategy for multi-verse display
5. Test coverage for range edge cases

---

## Note 4: Vector Search for Semantic Detection

### Why Requested
User requested vector search for semantic/paraphrase-aware verse detection.

### What This Would Require
1. **Vector embeddings**: Embed entire Bible text as vectors
2. **Embedding service**: OpenAI embeddings or local model
3. **Vector database**: Store and query embeddings
4. **Semantic similarity**: Search by meaning, not exact match
5. **Storage**: Embeddings cache or database
6. **Compute**: GPU or high-CPU for embeddings

### Architectural Impact
**EXPLICITLY LOCKED per ARCHITECTURE.md section 3 and AGENTS.md section 4**: "Vector search stays deferred."

**Breaking Changes**:
- Requires new infrastructure (vector database)
- Requires external embedding service or local model
- Significant performance impact
- Changes detection pipeline fundamentally
- Adds large storage requirement
- Moves from deterministic to probabilistic matching

### Recommendation
**REJECTED** - This fundamentally changes the detection model from deterministic regex to probabilistic semantic search. The current architecture explicitly favors explicit, deterministic detection (ARCHITECTURE.md section 12). Semantic detection is approved only as an optional, suggestion-only AI feature (sections 121, 124), not as a core vector search system.

---

## Note 5: Plugin System

### Why Requested
User requested a plugin system for extensibility.

### Architectural Impact
**EXPLICITLY FORBIDDEN per ARCHITECTURE.md section 51**: "This project must not implement: plugin discovery, dynamic loading, plugin manifests, runtime module installation, config-driven dependency injection unless a future architecture revision explicitly requires them."

**Violation**:
- AGENTS.md section 6: "Provider interfaces exist to isolate external implementations. They do NOT justify creating a plugin framework."
- AGENTS.md section 26: "No God Objects" - plugin systems often lead to this
- AGENTS.md section 41: "No Premature Frameworks" - plugin framework is premature

### Recommendation
**BLOCKED** - This directly violates the architecture. The four extension seams (AsrProvider, VerseDetector, VerseSource, VerseIndex) are intentionally fixed TypeScript interfaces, not a dynamic plugin system. The architecture explicitly rejects plugin frameworks in favor of static, typed implementations.

---

## Summary

| Feature | Status | Reason |
|---------|--------|--------|
| Cloud Sync | REJECTED | Fundamentally changes architecture from local to cloud-hosted |
| Automatic OBS Control | DEFERRED | Possible for Phase 2 with architecture note |
| Verse Ranges | DEFERRED | Possible with explicit product requirement |
| Vector Search | REJECTED | Violates deterministic detection principle |
| Plugin System | BLOCKED | Explicitly forbidden by ARCHITECTURE.md section 51 |

The architecture is designed to remain small, deterministic, and local-first. Any feature that would require a backend, cloud infrastructure, or dynamic loading should be a separate product, not a feature of ChurchOverlay.
