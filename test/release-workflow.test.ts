import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('release deployment uses a reviewed pinned SSH host key', () => {
  assert.match(workflow, /deploy:\n    needs: docker\n    runs-on: ubuntu-latest\n    environment: production/);
  assert.match(workflow, /SSH_KNOWN_HOSTS: \$\{\{ secrets\.SSH_KNOWN_HOSTS \}\}/);
  assert.match(workflow, /ssh-keygen -F "\$known_host" -f "\$HOME\/\.ssh\/known_hosts"/);
  assert.equal((workflow.match(/StrictHostKeyChecking=yes/g) ?? []).length, 3);
  assert.equal((workflow.match(/ssh -i "\$HOME\/\.ssh\/deploy_key"/g) ?? []).length, 3);
  assert.match(workflow, /known_host="\[\$SSH_DOMAIN\]:\$SSH_PORT"/);
  assert.doesNotMatch(workflow, /ssh-keyscan -p "\$SSH_PORT" "\$SSH_DOMAIN" >>/);
});
