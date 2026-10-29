# Graph deletion authorization checks

`test_graph_delete_scope.py` runs in the normal Python suite and checks that the
actual query binds the target UUID and authorized partition together. Empty
partitions cannot initialize the database. Reverting the fix fails all eight cases.

`test_graph_delete_integration.py` drives the real FastAPI delete endpoints and real
Cypher against a disposable local Neo4j, without Graphiti initialization, embeddings,
or an LLM. It verifies both the response and the complete before/after fixture graph.
Cases cover another tenant, sibling/similarly named partitions, untagged records,
foreign or untagged relationships, metadata edges, allowed deletes, missing targets,
and missing service authentication.

Run locally (the database is emptied between cases):

```sh
docker run -d --rm --name willder-delete-test \
  -p 127.0.0.1:17687:7687 -e NEO4J_AUTH=none \
  -e NEO4J_server_memory_heap_initial__size=256m \
  -e NEO4J_server_memory_heap_max__size=512m \
  -e NEO4J_server_memory_pagecache_size=256m neo4j:5.26-community
# Wait for Neo4j to start, then from memory-service:
NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_graph_delete_integration.py
# After verification:
docker stop willder-delete-test
```

The integration suite accepts only the loopback address and port above. It never
uses the application's configured production database. Ordinary CI skips it unless
explicitly enabled, so it adds no hosted database job to routine CI.

Deletion is exact-partition only. A bare organization ID covers records stored in
that legacy partition; it is not a wildcard for other scoped partitions. Callers
must pass the target's authorized partition. Mixed/unknown graph ownership fails
closed as not-found. Entity removal explicitly deletes the verified edges and then
the node, rather than using an unchecked `DETACH DELETE` cascade. An additional
concurrent relationship cannot be silently removed by that node deletion.
