/**
 * Windows 通知读取层：时间换算与 toast XML 解析（不依赖真实通知库）。
 *
 * 跑法：node --experimental-strip-types --test src/host/system-notify/windows.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WPN_DB_RELATIVE_PATH,
  fileTimeToUnixMs,
  openWindowsNotifications,
  parseToastXml,
  wpnDatabasePath,
} from './windows.ts';

describe('fileTimeToUnixMs', () => {
  test('Unix 纪元对应 116444736000000000', () => {
    assert.equal(fileTimeToUnixMs(116444736000000000n), 0);
  });

  test('一秒就是一百万个 100ns 单位', () => {
    assert.equal(fileTimeToUnixMs(116444736000000000n + 10_000_000n), 1000);
  });

  test('早于 Unix 纪元的值判非法', () => {
    assert.equal(fileTimeToUnixMs(0n), null);
  });
});

describe('parseToastXml', () => {
  test('第一个 text 是标题、第二个是正文', () => {
    const xml = '<toast><visual><binding><text id="1">标题</text><text id="2">正文</text></binding></visual></toast>';
    assert.deepEqual(parseToastXml(xml), { title: '标题', body: '正文' });
  });

  test('只有标题时正文为空', () => {
    const xml = '<toast><visual><binding><text id="1">只有标题</text></binding></visual></toast>';
    assert.deepEqual(parseToastXml(xml), { title: '只有标题', body: '' });
  });

  test('CDATA 与实体都剥掉', () => {
    const xml = '<toast><text id="1"><![CDATA[A & B]]></text><text id="2">&lt;标签&gt;</text></toast>';
    assert.deepEqual(parseToastXml(xml), { title: 'A & B', body: '<标签>' });
  });

  test('空白压成单个空格', () => {
    const xml = '<toast><text id="1">  多  空格 \n 换行 </text></toast>';
    assert.equal(parseToastXml(xml).title, '多 空格 换行');
  });

  test('没有 text 元素时两个都空', () => {
    assert.deepEqual(parseToastXml('<toast></toast>'), { title: '', body: '' });
  });
});

describe('通知库路径', () => {
  test('相对路径落在 Windows 通知目录下', () => {
    assert.equal(
      WPN_DB_RELATIVE_PATH,
      join('AppData', 'Local', 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db'),
    );
  });

  test('全路径以相对路径结尾', () => {
    assert.ok(wpnDatabasePath().endsWith(WPN_DB_RELATIVE_PATH));
  });
});

describe('openWindowsNotifications', () => {
  test('打不开时返回空读器（读不到就是读不到，不抛）', () => {
    const reader = openWindowsNotifications(join('Z:\\definitely\\not\\here.db'));
    assert.deepEqual(reader.readSince(0), []);
    assert.equal(reader.maxToastId(42), 42);
    reader.close();
  });

  test('真库真读：新增 toast 的标题、正文与来源应用都对得上', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-wpn-'));
    const dbPath = join(dir, 'wpndatabase.db');
    try {
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
        DatabaseSync: new (path: string) => {
          prepare(sql: string): { run(...params: unknown[]): void };
          close(): void;
        };
      };
      const db = new DatabaseSync(dbPath);
      db.prepare(
        'CREATE TABLE Notification (Id INTEGER PRIMARY KEY, HandlerId INTEGER, Type TEXT, Payload BLOB, ArrivalTime INTEGER)',
      ).run();
      db.prepare('CREATE TABLE NotificationHandler (RecordId INTEGER PRIMARY KEY, PrimaryId TEXT)').run();
      db.prepare('INSERT INTO NotificationHandler (RecordId, PrimaryId) VALUES (?, ?)').run(7, 'org.test.app');
      const xml = '<toast><visual><binding><text id="1">标题</text><text id="2">正文</text></binding></visual></toast>';
      // 两条 toast + 一条压缩副本（toastCondensed 载荷为 null，必须被忽略）
      db.prepare('INSERT INTO Notification (Id, HandlerId, Type, Payload, ArrivalTime) VALUES (?, ?, ?, ?, ?)').run(
        10,
        7,
        'toast',
        Buffer.from(xml, 'utf8'),
        134396583831797903n,
      );
      db.prepare('INSERT INTO Notification (Id, HandlerId, Type, Payload, ArrivalTime) VALUES (?, ?, ?, ?, ?)').run(
        11,
        7,
        'toast',
        Buffer.from(xml, 'utf8'),
        134396583831797903n,
      );
      db.prepare('INSERT INTO Notification (Id, HandlerId, Type, Payload, ArrivalTime) VALUES (?, ?, ?, ?, ?)').run(
        12,
        7,
        'toastCondensed',
        null,
        134396583831797903n,
      );
      db.close();

      const reader = openWindowsNotifications(dbPath);
      try {
        assert.equal(reader.maxToastId(0), 11);
        const batch = reader.readSince(0);
        assert.equal(batch.length, 2);
        assert.equal(batch[0]?.appId, 'org.test.app');
        assert.equal(batch[0]?.title, '标题');
        assert.equal(batch[0]?.body, '正文');
        assert.equal(batch[0]?.id, 10);
        // 水位线以上才给；压缩副本（toastCondensed）载荷为 null，不算一条
        assert.equal(reader.readSince(10).length, 1);
        assert.equal(reader.readSince(11).length, 0);
      } finally {
        reader.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
