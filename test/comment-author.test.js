// One name for every comment (#1391): the setting first, the system account's
// full name while it is empty, '' only when neither is there.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

let dom = null;
let author = null;

test.before(async () => {
  dom = setupRendererDom();
  author = await importRenderer('file-views', 'comment-author.js');
});

test.after(() => dom?.cleanup());

const api = ({ setting, account, prefsFail = false, accountFail = false } = {}) => {
  const calls = { account: 0 };
  return {
    calls,
    getUIPrefs: async () => {
      if (prefsFail) throw new Error('unreadable');
      return setting === undefined ? {} : { commentAuthor: setting };
    },
    commentAccountName: async () => {
      calls.account += 1;
      if (accountFail) throw new Error('no lookup');
      return account;
    },
  };
};

test('the setting wins over the account name', async () => {
  assert.equal(await author.commentAuthor(api({ setting: ' Ada ', account: 'Kim Example' })), 'Ada');
});

test('an empty or missing setting falls back to the account name', async () => {
  assert.equal(await author.commentAuthor(api({ setting: '  ', account: 'Kim Example' })), 'Kim Example');
  assert.equal(await author.commentAuthor(api({ account: 'Kim Example' })), 'Kim Example');
  assert.equal(await author.commentAuthor(api({ prefsFail: true, account: 'Kim Example' })), 'Kim Example');
});

test('without either, the comment goes out unsigned', async () => {
  assert.equal(await author.commentAuthor(api({ setting: '', account: '' })), '');
  assert.equal(await author.commentAuthor(api({ accountFail: true })), '');
  assert.equal(await author.commentAuthor({}), '');
  assert.equal(await author.commentAuthor(null), '');
});

test('main is asked for the account name once per api, the setting every time', async () => {
  let setting = '';
  const shared = { ...api({ account: 'Kim Example' }), getUIPrefs: async () => ({ commentAuthor: setting }) };
  const counted = api({ account: 'Kim Example' });
  shared.commentAccountName = counted.commentAccountName;
  assert.equal(await author.commentAuthor(shared), 'Kim Example');
  assert.equal(await author.commentAuthor(shared), 'Kim Example');
  setting = 'Ada';
  assert.equal(await author.commentAuthor(shared), 'Ada');
  assert.equal(counted.calls.account, 1);
});
