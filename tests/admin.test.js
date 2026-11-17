import assert from 'node:assert/strict';
import test from 'node:test';
import { requireAdmin } from '../src/admin.js';

const TOKEN = 'this-is-a-long-enough-admin-token';

test('requireAdmin accepts the configured token', async () => {
  const request = new Request('https://essay.example.com/api/admin/stats', {
    headers: { 'x-admin-token': TOKEN }
  });
  await assert.doesNotReject(requireAdmin(request, { ADMIN_TOKEN: TOKEN }));
});

test('requireAdmin rejects a wrong or missing token', async () => {
  await assert.rejects(requireAdmin(new Request('https://essay.example.com/api/admin/stats', {
    headers: { 'x-admin-token': 'wrong-token' }
  }), { ADMIN_TOKEN: TOKEN }), (error) => error.code === 'admin_unauthorized');

  await assert.rejects(requireAdmin(new Request('https://essay.example.com/api/admin/stats'), {
    ADMIN_TOKEN: TOKEN
  }), (error) => error.code === 'admin_unauthorized');
});

test('requireAdmin is disabled when ADMIN_TOKEN is missing or too short', async () => {
  await assert.rejects(requireAdmin(new Request('https://essay.example.com/api/admin/stats', {
    headers: { 'x-admin-token': 'short' }
  }), {}), (error) => error.code === 'admin_not_configured');

  await assert.rejects(requireAdmin(new Request('https://essay.example.com/api/admin/stats', {
    headers: { 'x-admin-token': 'short' }
  }), { ADMIN_TOKEN: 'too-short' }), (error) => error.code === 'admin_not_configured');
});
