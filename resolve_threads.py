import subprocess
import json

# Get unresolved threads
result = subprocess.run(
    ['gh', 'api', 'graphql', '-f', 
     'query={ repository(owner: "devdocket", name: "devdocket") { pullRequest(number: 349) { reviewThreads(first: 50) { nodes { id isResolved } } } } }'],
    capture_output=True,
    text=True
)

data = json.loads(result.stdout)
threads = [t['id'] for t in data['data']['repository']['pullRequest']['reviewThreads']['nodes'] if not t['isResolved']]

print(f'Found {len(threads)} unresolved threads')

# Resolve each thread
for tid in threads:
    mutation = f'mutation {{ resolveReviewThread(input: {{threadId: "{tid}"}}) {{ thread {{ isResolved }} }} }}'
    result = subprocess.run(
        ['gh', 'api', 'graphql', '-f', f'query={mutation}'],
        capture_output=True,
        text=True
    )
    resp = json.loads(result.stdout)
    resolved = resp.get('data', {}).get('resolveReviewThread', {}).get('thread', {}).get('isResolved', False)
    print(f'Resolved {tid}: {resolved}')

print('All threads resolved!')
