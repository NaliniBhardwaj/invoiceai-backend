// prisma/seed.ts
//
// Run with: npx prisma db seed
// (make sure prisma.schema has: "seed": "ts-node prisma/seed.ts" under
//  the "prisma" key in package.json, or use tsx if that's what you use)
//
// This creates 2 orgs, permissions/roles/users, customers, purchase orders,
// invoices (with line items + payments across different statuses),
// a reconciliation run with findings, and audit/event log rows.

import { PrismaClient, InvoiceType, InvoiceStatus, POStatus, ReconSourceType, ReconStatus, FindingType, FindingSeverity, JobRunStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Matches the hashing your auth flow actually uses, so seeded users can log
// in for real. All seeded users share the password 'password123'.
const SEED_PASSWORD_HASH = bcrypt.hashSync('password123', 10);

async function main() {
  console.log('Seeding...');

  // ── PERMISSIONS ──────────────────────────────────────────
  const permissionKeys = [
    'invoice:create', 'invoice:read', 'invoice:update', 'invoice:delete',
    'payment:create', 'payment:read',
    'customer:create', 'customer:read', 'customer:update',
    'purchaseorder:create', 'purchaseorder:read',
    'reconciliation:run', 'reconciliation:read',
    'user:manage', 'role:manage',
  ];

  const permissions = await Promise.all(
    permissionKeys.map((key) =>
      prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key, description: `Permission to ${key.replace(':', ' ')}` },
      })
    )
  );

  const permByKey = Object.fromEntries(permissions.map((p) => [p.key, p]));

  // ── SYSTEM ROLES (organizationId: null) ─────────────────
  const roleDefs: Record<string, string[]> = {
    OWNER: permissionKeys, // everything
    ADMIN: permissionKeys.filter((k) => k !== 'role:manage'),
    ACCOUNTANT: [
      'invoice:create', 'invoice:read', 'invoice:update',
      'payment:create', 'payment:read',
      'customer:create', 'customer:read', 'customer:update',
      'purchaseorder:create', 'purchaseorder:read',
      'reconciliation:run', 'reconciliation:read',
    ],
    VIEWER: ['invoice:read', 'payment:read', 'customer:read', 'purchaseorder:read', 'reconciliation:read'],
  };

  const systemRoles: Record<string, { id: string }> = {};
  for (const [name, keys] of Object.entries(roleDefs)) {
    let role = await prisma.role.findFirst({
      where: { organizationId: null, name },
    });

    if (!role) {
      role = await prisma.role.create({
        data: {
          name,
          isSystem: true,
          organizationId: null,
          rolePermissions: {
            create: keys.map((k) => ({ permissionId: permByKey[k].id })),
          },
        },
      });
    }

    systemRoles[name] = role;
  }

  // ── ORGANIZATIONS ────────────────────────────────────────
  const orgA = await prisma.organization.create({
    data: {
      name: 'Nimbus Retail Pvt Ltd',
      gstNumber: '07AAACN1234F1Z5',
      state: 'Delhi',
      address: '4th Floor, Nehru Place, New Delhi, 110019',
    },
  });

  const orgB = await prisma.organization.create({
    data: {
      name: 'Solaris Consulting LLP',
      gstNumber: '27AAACS5678K1Z9',
      state: 'Maharashtra',
      address: 'BKC, Mumbai, 400051',
    },
  });

  // ── USERS + ROLE ASSIGNMENTS ─────────────────────────────
  const usersData = [
    { org: orgA, name: 'Ananya Rao', email: 'ananya@nimbusretail.test', role: 'OWNER' },
    { org: orgA, name: 'Rohit Sharma', email: 'rohit@nimbusretail.test', role: 'ACCOUNTANT' },
    { org: orgA, name: 'Priya Nair', email: 'priya@nimbusretail.test', role: 'VIEWER' },
    { org: orgB, name: 'Vikram Desai', email: 'vikram@solarisconsulting.test', role: 'OWNER' },
    { org: orgB, name: 'Meera Iyer', email: 'meera@solarisconsulting.test', role: 'ADMIN' },
  ];

  const users: Record<string, { id: string; organizationId: string }> = {};
  for (const u of usersData) {
    const user = await prisma.user.create({
      data: {
        organizationId: u.org.id,
        email: u.email,
        name: u.name,
        passwordHash: SEED_PASSWORD_HASH,
        userRoles: {
          create: {
            roleId: systemRoles[u.role].id,
            organizationId: u.org.id,
          },
        },
      },
    });
    users[u.email] = user;
  }

  // ── CUSTOMERS ─────────────────────────────────────────────
  const custA1 = await prisma.customer.create({
    data: {
      organizationId: orgA.id,
      name: 'Kavita Menon',
      companyName: 'Bluewave Traders',
      gstNumber: '07AACCB1111M1Z3',
      billingAddress: '12 Connaught Place, New Delhi, 110001',
      state: 'Delhi', // same state as org -> CGST+SGST
      email: 'accounts@bluewavetraders.test',
      phone: '9810000001',
    },
  });

  const custA2 = await prisma.customer.create({
    data: {
      organizationId: orgA.id,
      name: 'Sanjay Gupta',
      companyName: 'Orbit Logistics',
      gstNumber: '29AACCO2222N1Z8',
      billingAddress: '221 MG Road, Bengaluru, 560001',
      state: 'Karnataka', // different state -> IGST
      email: 'billing@orbitlogistics.test',
      phone: '9810000002',
    },
  });

  const custB1 = await prisma.customer.create({
    data: {
      organizationId: orgB.id,
      name: 'Neha Kulkarni',
      companyName: 'Zenith Analytics',
      gstNumber: '27AACCZ3333P1Z1',
      billingAddress: 'Andheri East, Mumbai, 400069',
      state: 'Maharashtra', // same state -> CGST+SGST
      email: 'finance@zenithanalytics.test',
      phone: '9820000003',
    },
  });

  // ── PURCHASE ORDERS ───────────────────────────────────────
  const poA1 = await prisma.purchaseOrder.create({
    data: {
      organizationId: orgA.id,
      customerId: custA2.id,
      poNumber: 'PO-2026-001',
      status: POStatus.PARTIALLY_INVOICED,
    },
  });

  // ── INVOICES + LINE ITEMS + PAYMENTS ──────────────────────
  // Helper to compute GST split
  function taxSplit(subtotal: number, taxPct: number, sameState: boolean) {
    const tax = +(subtotal * (taxPct / 100)).toFixed(2);
    if (sameState) {
      return { cgst: +(tax / 2).toFixed(2), sgst: +(tax / 2).toFixed(2), igst: 0 };
    }
    return { cgst: 0, sgst: 0, igst: tax };
  }

  // Invoice 1: Nimbus -> Bluewave (same state, PAID in full)
  {
    const subtotal = 50000;
    const taxPct = 18;
    const { cgst, sgst, igst } = taxSplit(subtotal, taxPct, true);
    const grandTotal = subtotal + cgst + sgst + igst;

    const invoice = await prisma.invoice.create({
      data: {
        organizationId: orgA.id,
        customerId: custA1.id,
        invoiceNumber: 'INV-2026-0001',
        type: InvoiceType.SUBSCRIPTION_NEW,
        status: InvoiceStatus.PAID,
        subscriptionPlan: 'Pro Monthly',
        subscriptionDuration: 1,
        invoiceDate: new Date('2026-05-01'),
        dueDate: new Date('2026-05-15'),
        subtotal, taxPercentage: taxPct, cgst, sgst, igst, grandTotal,
        lineItems: {
          create: [
            { description: 'Pro Plan Subscription - May 2026', quantity: 1, unitPrice: subtotal, lineTotal: subtotal },
          ],
        },
        payments: {
          create: [
            { organizationId: orgA.id, amount: grandTotal, paidAt: new Date('2026-05-10'), method: 'UPI', reference: 'UPI-TXN-88213' },
          ],
        },
      },
    });
    console.log('Created invoice', invoice.invoiceNumber);
  }

  // Invoice 2: Nimbus -> Orbit Logistics (diff state, tied to PO, PARTIALLY_PAID)
  let invoice2Id: string;
  {
    const subtotal = 120000;
    const taxPct = 18;
    const { cgst, sgst, igst } = taxSplit(subtotal, taxPct, false);
    const grandTotal = subtotal + cgst + sgst + igst;

    const invoice = await prisma.invoice.create({
      data: {
        organizationId: orgA.id,
        customerId: custA2.id,
        purchaseOrderId: poA1.id,
        invoiceNumber: 'INV-2026-0002',
        type: InvoiceType.PURCHASE_ORDER,
        status: InvoiceStatus.PARTIALLY_PAID,
        invoiceDate: new Date('2026-06-01'),
        dueDate: new Date('2026-06-20'),
        subtotal, taxPercentage: taxPct, cgst, sgst, igst, grandTotal,
        lineItems: {
          create: [
            { description: 'Logistics software license (annual)', quantity: 1, unitPrice: 100000, lineTotal: 100000 },
            { description: 'Onboarding & setup', quantity: 1, unitPrice: 20000, lineTotal: 20000 },
          ],
        },
        payments: {
          create: [
            { organizationId: orgA.id, amount: 70000, paidAt: new Date('2026-06-15'), method: 'Bank Transfer', reference: 'NEFT-556213' },
          ],
        },
      },
    });
    invoice2Id = invoice.id;
    console.log('Created invoice', invoice.invoiceNumber);
  }

  // Invoice 3: Nimbus -> Bluewave (same state, OVERDUE, unpaid)
  {
    const subtotal = 15000;
    const taxPct = 18;
    const { cgst, sgst, igst } = taxSplit(subtotal, taxPct, true);
    const grandTotal = subtotal + cgst + sgst + igst;

    const invoice = await prisma.invoice.create({
      data: {
        organizationId: orgA.id,
        customerId: custA1.id,
        invoiceNumber: 'INV-2026-0003',
        type: InvoiceType.ONE_TIME,
        status: InvoiceStatus.OVERDUE,
        invoiceDate: new Date('2026-04-10'),
        dueDate: new Date('2026-04-25'),
        subtotal, taxPercentage: taxPct, cgst, sgst, igst, grandTotal,
        lineItems: {
          create: [
            { description: 'One-time data migration service', quantity: 1, unitPrice: subtotal, lineTotal: subtotal },
          ],
        },
      },
    });
    console.log('Created invoice', invoice.invoiceNumber);
  }

  // Invoice 4: Solaris -> Zenith (same state, DRAFT, not issued yet)
  {
    const subtotal = 80000;
    const taxPct = 18;
    const { cgst, sgst, igst } = taxSplit(subtotal, taxPct, true);
    const grandTotal = subtotal + cgst + sgst + igst;

    const invoice = await prisma.invoice.create({
      data: {
        organizationId: orgB.id,
        customerId: custB1.id,
        invoiceNumber: 'INV-2026-0001',
        type: InvoiceType.SUBSCRIPTION_RENEWAL,
        status: InvoiceStatus.DRAFT,
        subscriptionPlan: 'Enterprise Quarterly',
        subscriptionDuration: 3,
        invoiceDate: new Date('2026-07-01'),
        dueDate: new Date('2026-07-15'),
        subtotal, taxPercentage: taxPct, cgst, sgst, igst, grandTotal,
        lineItems: {
          create: [
            { description: 'Enterprise Plan Renewal - Q3 2026', quantity: 1, unitPrice: subtotal, lineTotal: subtotal },
          ],
        },
      },
    });
    console.log('Created invoice', invoice.invoiceNumber);
  }

  // ── RECONCILIATION RUN + FINDINGS ─────────────────────────
  const reconRun = await prisma.reconciliationRun.create({
    data: {
      organizationId: orgA.id,
      period: '2026-06',
      sourceType: ReconSourceType.GST_CSV,
      sourceFileUrl: 'https://storage.example.test/gst-uploads/2026-06-orga.csv',
      status: ReconStatus.COMPLETED,
      completedAt: new Date('2026-06-28'),
      findings: {
        create: [
          {
            type: FindingType.GST_MISMATCH,
            severity: FindingSeverity.HIGH,
            invoiceId: invoice2Id,
            description: 'GST portal shows IGST of ₹19,800 but invoice records ₹21,600 IGST.',
            expectedValue: '21600',
            actualValue: '19800',
          },
          {
            type: FindingType.MISSING_PAYMENT,
            severity: FindingSeverity.MEDIUM,
            invoiceId: invoice2Id,
            description: 'Partial payment of ₹70,000 not yet reflected against GST filing.',
          },
          {
            type: FindingType.DUPLICATE_GST_ENTRY,
            severity: FindingSeverity.LOW,
            description: 'Possible duplicate entry detected for invoice reference INV-2026-0001 in GST CSV row 44 and row 91.',
          },
        ],
      },
    },
  });
  console.log('Created reconciliation run', reconRun.id, 'with findings');

  // ── AUDIT LOGS ─────────────────────────────────────────────
  await prisma.auditLog.createMany({
    data: [
      {
        organizationId: orgA.id,
        userId: users['ananya@nimbusretail.test'].id,
        action: 'INVOICE_CREATED',
        entityType: 'Invoice',
        entityId: invoice2Id,
        metadata: { invoiceNumber: 'INV-2026-0002' },
      },
      {
        organizationId: orgA.id,
        userId: users['rohit@nimbusretail.test'].id,
        action: 'PAYMENT_RECORDED',
        entityType: 'Payment',
        entityId: invoice2Id,
        metadata: { amount: 70000, method: 'Bank Transfer' },
      },
    ],
  });

  // ── DOMAIN EVENT LOGS ────────────────────────────────────
  await prisma.domainEventLog.createMany({
    data: [
      {
        organizationId: orgA.id,
        type: 'invoice.created',
        payload: { invoiceId: invoice2Id, invoiceNumber: 'INV-2026-0002' },
        actorId: users['ananya@nimbusretail.test'].id,
      },
      {
        organizationId: orgA.id,
        type: 'reconciliation.completed',
        payload: { runId: reconRun.id, findingsCount: 3 },
      },
    ],
  });

  // ── SCHEDULED JOB RUNS ───────────────────────────────────
  await prisma.scheduledJobRun.createMany({
    data: [
      {
        jobName: 'invoice-overdue-checker',
        status: JobRunStatus.SUCCESS,
        finishedAt: new Date(),
        result: { flagged: 1 },
      },
      {
        jobName: 'gst-reconciliation-nightly',
        status: JobRunStatus.SUCCESS,
        finishedAt: new Date(),
        result: { runsProcessed: 1 },
      },
    ],
  });

  // ── AI CONVERSATION ──────────────────────────────────────
  await prisma.aIConversation.create({
    data: {
      organizationId: orgA.id,
      userId: users['ananya@nimbusretail.test'].id,
      messages: {
        create: [
          { role: 'user', content: 'Create an invoice for Bluewave Traders for ₹15,000 one-time service.' },
          {
            role: 'assistant',
            content: 'Created invoice INV-2026-0003 for Bluewave Traders, subtotal ₹15,000, GST 18% (CGST+SGST since same state).',
            actionTaken: 'CREATE_INVOICE',
            actionPayload: { invoiceNumber: 'INV-2026-0003', subtotal: 15000 },
          },
        ],
      },
    },
  });

  console.log('Seed complete ✅');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });