import { print, shortDate, table } from '../util.js';

const EXP = 'notifications';

const FEED_QUERY = `query AtlNotificationFeed($ctx: String, $first: Int, $after: String, $filter: InfluentsNotificationFilter) {
  notifications {
    notificationFeed(collabContextRoutingAri: $ctx, first: $first, after: $after, filter: $filter) {
      pageInfo { hasNextPage endCursor }
      nodes {
        groupId
        groupSize
        readStates
        additionalActors { displayName }
        headNotification {
          notificationId
          category
          readState
          timestamp
          content {
            type
            message
            url
            actor { displayName }
            entity { title url }
            path { title url }
            bodyItems { document { format data } }
          }
        }
      }
    }
  }
}`;

function product(groupId = '') {
  const m = groupId.match(/^ari:cloud:([^:]+):/);
  return m ? m[1] : '';
}

function bodyText(items) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text' && n.text) out.push(n.text);
    if (n.type === 'mention' && n.attrs?.text) out.push(n.attrs.text);
    (n.content || []).forEach(walk);
    if (n.type === 'paragraph') out.push(' ');
  };
  for (const it of items || []) {
    const doc = it?.document;
    if (!doc?.data) continue;
    try {
      walk(typeof doc.data === 'string' ? JSON.parse(doc.data) : doc.data);
    } catch {
      if (typeof doc.data === 'string') out.push(doc.data);
    }
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

function flatten(node) {
  const h = node.headNotification;
  const c = h.content || {};
  return {
    id: h.notificationId,
    groupId: node.groupId,
    groupSize: node.groupSize,
    product: product(node.groupId),
    category: h.category,
    readState: h.readState,
    unread: (node.readStates || []).includes('unread') || h.readState === 'unread',
    timestamp: h.timestamp,
    type: c.type,
    actor: c.actor?.displayName,
    otherActors: (node.additionalActors || []).map((a) => a.displayName),
    title: c.entity?.title,
    url: c.url || c.entity?.url,
    container: (c.path ?? []).map((p) => p.title).filter(Boolean).join(' / '),
    message: c.message,
    body: bodyText(c.bodyItems),
  };
}

export const notifications = {
  list: {
    summary: 'List notifications from the Atlassian notification bell',
    usage: 'atl notifications list [--unread] [--direct|--watching] [--product jira|confluence] [--since <ISO>] [--limit 50]',
    options: {
      unread: { type: 'boolean' },
      direct: { type: 'boolean' },
      watching: { type: 'boolean' },
      product: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string', default: '50' },
    },
    async run(client, _args, opts) {
      const ctx = `ari:cloud:platform::site/${await client.cloudId()}`;
      const filter = {};
      if (opts.unread) filter.readStateFilter = 'unread';
      if (opts.direct) filter.categoryFilter = 'direct';
      if (opts.watching) filter.categoryFilter = 'watching';
      if (opts.product) filter.productFilter = opts.product;
      if (opts.since) filter.afterTimestamp = new Date(opts.since).toISOString();
      const limit = Number(opts.limit);
      const items = [];
      let after;
      let hasMore = false;
      do {
        const data = await client.graphql(
          FEED_QUERY,
          { ctx, first: Math.min(50, limit - items.length), after, filter },
          { readOnly: true, experimental: EXP },
        );
        const feed = data.notifications.notificationFeed;
        items.push(...feed.nodes.map(flatten));
        hasMore = feed.pageInfo.hasNextPage;
        after = feed.pageInfo.endCursor;
      } while (hasMore && after && items.length < limit);
      print({ items, hasMore }, opts, ({ items, hasMore }) =>
        table(
          items.map((i) => ({ ...i, when: shortDate(i.timestamp), u: i.unread ? '●' : ' ' })),
          [
            { key: 'u', label: ' ' },
            { key: 'when', label: 'When' },
            { key: 'category', label: 'Cat' },
            { key: 'product', label: 'Product' },
            { key: 'title', label: 'Title', max: 50 },
            { key: 'message', label: 'Message', max: 60 },
          ],
        ) + (hasMore ? `\n… more available (raise --limit)` : ''),
      );
    },
  },

  read: {
    summary: 'Mark notifications as read (by notification id, group id, or all)',
    usage: 'atl notifications read <id|groupId>... | --all [--direct|--watching]',
    options: {
      all: { type: 'boolean' },
      direct: { type: 'boolean' },
      watching: { type: 'boolean' },
    },
    async run(client, args, opts) {
      const ctx = `ari:cloud:platform::site/${await client.cloudId()}`;
      const category = opts.direct ? 'direct' : opts.watching ? 'watching' : undefined;
      if (opts.all) {
        await client.graphql(
          `mutation AtlMarkAllRead($ctx: String, $category: InfluentsNotificationCategory) { notifications { markNotificationsAsRead(collabContextRoutingAri: $ctx, category: $category) } }`,
          { ctx, category },
          { experimental: EXP },
        );
        return print({ markedRead: 'all', category: category ?? 'any' }, opts, () => `Marked all${category ? ` ${category}` : ''} notifications as read.`);
      }
      if (!args.length) throw new Error('Give notification ids / group ids, or use --all.');
      const groups = args.filter((a) => a.startsWith('ari:'));
      const ids = args.filter((a) => !a.startsWith('ari:'));
      if (ids.length) {
        await client.graphql(
          `mutation AtlMarkRead($ctx: String, $ids: [String!]!) { notifications { markNotificationsByIdsAsRead(collabContextRoutingAri: $ctx, ids: $ids) } }`,
          { ctx, ids },
          { experimental: EXP },
        );
      }
      for (const groupId of groups) {
        await client.graphql(
          `mutation AtlMarkGroupRead($ctx: String, $groupId: String!) { notifications { markNotificationsByGroupIdAsRead(collabContextRoutingAri: $ctx, groupId: $groupId) } }`,
          { ctx, groupId },
          { experimental: EXP },
        );
      }
      print({ markedRead: { ids, groups } }, opts, () => `Marked ${ids.length + groups.length} item(s) as read.`);
    },
  },

  unread: {
    summary: 'Mark notifications as unread (by notification id or group id)',
    usage: 'atl notifications unread <id|groupId>...',
    async run(client, args, opts) {
      if (!args.length) throw new Error('Give notification ids or group ids.');
      const ctx = `ari:cloud:platform::site/${await client.cloudId()}`;
      const groups = args.filter((a) => a.startsWith('ari:'));
      const ids = args.filter((a) => !a.startsWith('ari:'));
      if (ids.length) {
        await client.graphql(
          `mutation AtlMarkUnread($ctx: String, $ids: [String!]!) { notifications { markNotificationsByIdsAsUnread(collabContextRoutingAri: $ctx, ids: $ids) } }`,
          { ctx, ids },
          { experimental: EXP },
        );
      }
      for (const groupId of groups) {
        await client.graphql(
          `mutation AtlMarkGroupUnread($ctx: String, $groupId: String!) { notifications { markNotificationsByGroupIdAsUnread(collabContextRoutingAri: $ctx, groupId: $groupId) } }`,
          { ctx, groupId },
          { experimental: EXP },
        );
      }
      print({ markedUnread: { ids, groups } }, opts, () => `Marked ${ids.length + groups.length} item(s) as unread.`);
    },
  },

  count: {
    summary: 'Number of unseen notifications (badge count)',
    usage: 'atl notifications count',
    async run(client, _args, opts) {
      const ctx = `ari:cloud:platform::site/${await client.cloudId()}`;
      const data = await client.graphql(
        `query AtlUnseen($ctx: String) { notifications { unseenNotificationCount(collabContextRoutingAri: $ctx) } }`,
        { ctx },
        { readOnly: true, experimental: EXP },
      );
      const unseen = data.notifications.unseenNotificationCount;
      print({ unseen }, opts, () => String(unseen));
    },
  },
};
