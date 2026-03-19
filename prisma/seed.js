const { PrismaClient } = require("@prisma/client");

async function main() {
  const prisma = new PrismaClient();

  async function seedParentAndPlayer({
    parentId,
    phone,
    playerId,
  }) {
    await prisma.parent.upsert({
      where: { id: parentId },
      update: { phone, name: "Родитель" },
      create: { id: parentId, phone, name: "Родитель" },
    });

    await prisma.player.upsert({
      where: { id: playerId },
      update: {
        parentId,
        name: "Голыш Марк",
        position: "Forward",
        team: "Hockey ID",
        age: 12,
        games: 60,
        goals: 22,
        assists: 38,
        points: 60,
      },
      create: {
        id: playerId,
        parentId,
        name: "Голыш Марк",
        position: "Forward",
        team: "Hockey ID",
        age: 12,
        games: 60,
        goals: 22,
        assists: 38,
        points: 60,
      },
    });
  }

  async function seedSubscription(parentId) {
    const subscription = await prisma.subscription.upsert({
      where: { parentId },
      update: {
        planCode: "basic",
        status: "active",
        billingInterval: "monthly",
        currentPeriodStart: "2026-03-18",
        currentPeriodEnd: "2026-04-18",
        cancelAtPeriodEnd: false,
      },
      create: {
        parentId,
        planCode: "basic",
        status: "active",
        billingInterval: "monthly",
        currentPeriodStart: "2026-03-18",
        currentPeriodEnd: "2026-04-18",
        cancelAtPeriodEnd: false,
      },
    });

    const existing = await prisma.subscriptionBillingRecord.findFirst({
      where: {
        parentId,
        subscriptionId: subscription.id,
        billedAt: "2026-03-18",
      },
      orderBy: { createdAt: "desc" },
    });

    if (!existing) {
      await prisma.subscriptionBillingRecord.create({
        data: {
          parentId,
          subscriptionId: subscription.id,
          amount: "0",
          currency: "USD",
          status: "paid",
          billedAt: "2026-03-18",
        },
      });
    }
  }

  async function seedScheduleEvents() {
    const events = [
      {
        id: "sch_team_1_2026_03_19_1800",
        title: "Лёд: командная тренировка",
        startTime: "2026-03-19T15:00:00.000Z",
        location: "Казань Арена",
        teamId: "team_1",
      },
      {
        id: "sch_team_1_2026_03_21_1730",
        title: "ОФП: зал",
        startTime: "2026-03-21T14:30:00.000Z",
        location: "Спортзал Hockey ID",
        teamId: "team_1",
      },
      {
        id: "sch_team_1_2026_03_23_1900",
        title: "Лёд: техника и бросок",
        startTime: "2026-03-23T16:00:00.000Z",
        location: "Ледовый дворец",
        teamId: "team_1",
      },
      {
        id: "sch_team_2_2026_03_20_1630",
        title: "Тренировка",
        startTime: "2026-03-20T13:30:00.000Z",
        location: null,
        teamId: "team_2",
      },
    ];

    await Promise.all(
      events.map((e) =>
        prisma.scheduleEvent.upsert({
          where: { id: e.id },
          update: {
            title: e.title,
            startTime: e.startTime,
            location: e.location,
            teamId: e.teamId,
          },
          create: {
            id: e.id,
            title: e.title,
            startTime: e.startTime,
            location: e.location,
            teamId: e.teamId,
          },
        })
      )
    );
  }

  async function seedMarketplace() {
    const coaches = [
      {
        id: "coach_1",
        name: "Алексей Иванов",
        specialization: "Катание",
        rating: 4.9,
        priceFrom: 2500,
        city: "Казань",
        avatar: "",
        description: "Индивидуальные тренировки по катанию и технике",
      },
      {
        id: "coach_2",
        name: "Дмитрий Петров",
        specialization: "Бросок",
        rating: 4.8,
        priceFrom: 3000,
        city: "Казань",
        avatar: "",
        description: "Постановка броска и атакующие навыки",
      },
      {
        id: "coach_3",
        name: "Сергей Смирнов",
        specialization: "ОФП",
        rating: 4.7,
        priceFrom: 2000,
        city: "Казань",
        avatar: "",
        description: "Сила, выносливость и скорость для хоккеистов",
      },
    ];

    const slots = [
      { id: "slot_1", coachId: "coach_1", time: "2026-03-20T10:00:00.000Z", available: true },
      { id: "slot_2", coachId: "coach_1", time: "2026-03-20T12:00:00.000Z", available: true },
      { id: "slot_3", coachId: "coach_1", time: "2026-03-21T15:00:00.000Z", available: false },
      { id: "slot_4", coachId: "coach_2", time: "2026-03-20T11:00:00.000Z", available: true },
      { id: "slot_5", coachId: "coach_2", time: "2026-03-22T16:30:00.000Z", available: true },
    ];

    await Promise.all(
      coaches.map((c) =>
        prisma.coach.upsert({
          where: { id: c.id },
          update: {
            name: c.name,
            specialization: c.specialization,
            rating: c.rating,
            priceFrom: c.priceFrom,
            city: c.city,
            avatar: c.avatar,
            description: c.description,
          },
          create: {
            id: c.id,
            name: c.name,
            specialization: c.specialization,
            rating: c.rating,
            priceFrom: c.priceFrom,
            city: c.city,
            avatar: c.avatar,
            description: c.description,
          },
        })
      )
    );

    await Promise.all(
      slots.map((s) =>
        prisma.coachSlot.upsert({
          where: { id: s.id },
          update: {
            coachId: s.coachId,
            time: s.time,
            available: s.available,
          },
          create: {
            id: s.id,
            coachId: s.coachId,
            time: s.time,
            available: s.available,
          },
        })
      )
    );
  }

  async function seedTrainingEvents() {
    const events = [
      {
        id: "tr_team_1_2026_03_19_1930",
        title: "Тренировка: катание и техника",
        startTime: "2026-03-19T18:30:00.000Z",
        location: "Ледовый дворец",
        teamId: "team_1",
      },
      {
        id: "tr_team_1_2026_03_22_1600",
        title: "Тренировка: силовая работа",
        startTime: "2026-03-22T15:00:00.000Z",
        location: "Тренажерный зал",
        teamId: "team_1",
      },
      {
        id: "tr_team_2_2026_03_20_1700",
        title: "Тренировка",
        startTime: "2026-03-20T16:30:00.000Z",
        location: null,
        teamId: "team_2",
      },
    ];

    await Promise.all(
      events.map((e) =>
        prisma.trainingEvent.upsert({
          where: { id: e.id },
          update: {
            title: e.title,
            startTime: e.startTime,
            location: e.location,
            teamId: e.teamId,
          },
          create: {
            id: e.id,
            title: e.title,
            startTime: e.startTime,
            location: e.location,
            teamId: e.teamId,
          },
        })
      )
    );
  }

  async function seedFeedPosts() {
    const posts = [
      {
        id: "feed_post_1",
        teamId: "team_1",
        teamName: "Hockey ID",
        authorId: "admin_default",
        authorName: "Администратор",
        authorRole: "admin",
        type: "announcement",
        title: "Приветствуем на Hockey ID",
        body: "Начало сезона. Следите за расписанием тренировок и достижениями команды.",
        imageUrl: null,
        isPinned: true,
        createdAt: "2026-03-18T10:00:00.000Z",
        publishedAt: "2026-03-18T10:00:00.000Z",
      },
      {
        id: "feed_post_2",
        teamId: "team_1",
        teamName: "Hockey ID",
        authorId: "coach_default",
        authorName: "Тренер команды",
        authorRole: "coach",
        type: "training",
        title: "Лёд: техника и бросок",
        body: "На ближайшей тренировке сделаем акцент на выход из-под опеки и бросок после передачи в движении.",
        imageUrl: null,
        isPinned: false,
        createdAt: "2026-03-18T12:00:00.000Z",
        publishedAt: "2026-03-18T12:00:00.000Z",
      },
      {
        id: "feed_post_3",
        teamId: "team_2",
        teamName: "Команда 2",
        authorId: "admin_default",
        authorName: "Администратор",
        authorRole: "admin",
        type: "update",
        title: "Расписание недели",
        body: "Добавлены дополнительные занятия для подготовки к матчам. Проверьте календарь и выберите слот.",
        imageUrl: null,
        isPinned: false,
        createdAt: "2026-03-18T09:30:00.000Z",
        publishedAt: "2026-03-18T09:30:00.000Z",
      },
    ];

    await Promise.all(
      posts.map((p) =>
        prisma.feedPost.upsert({
          where: { id: p.id },
          update: {
            teamId: p.teamId,
            teamName: p.teamName,
            authorId: p.authorId,
            authorName: p.authorName,
            authorRole: p.authorRole,
            type: p.type,
            title: p.title,
            body: p.body,
            imageUrl: p.imageUrl,
            isPinned: p.isPinned,
            createdAt: p.createdAt,
            publishedAt: p.publishedAt,
          },
          create: {
            id: p.id,
            teamId: p.teamId,
            teamName: p.teamName,
            authorId: p.authorId,
            authorName: p.authorName,
            authorRole: p.authorRole,
            type: p.type,
            title: p.title,
            body: p.body,
            imageUrl: p.imageUrl,
            isPinned: p.isPinned,
            createdAt: p.createdAt,
            publishedAt: p.publishedAt,
          },
        })
      )
    );
  }

  async function seedChat() {
    const parentId = "parent-79990001122";
    const playerId = "player_1_real";

    const player = await prisma.player.findFirst({ where: { id: playerId, parentId } });
    if (!player) return;

    const conversation = await prisma.chatConversation.findFirst({
      where: { parentId, playerId },
    });

    let conversationId = conversation?.id;
    if (!conversation) {
      conversationId = "conv_seed_1";
      await prisma.chatConversation.create({
        data: {
          id: conversationId,
          playerId: player.id,
          playerName: player.name,
          coachId: "coach_default",
          coachName: "Тренер команды",
          parentId,
          lastMessage: null,
        },
      });
    }

    const messages = [
      {
        id: "msg_seed_1",
        text: "Здравствуйте! Когда будет следующая тренировка?",
        createdAt: "2026-03-18T13:00:00.000Z",
      },
      {
        id: "msg_seed_2",
        text: "На этой неделе: вторник и четверг. Посмотрите расписание в календаре.",
        createdAt: "2026-03-18T13:05:00.000Z",
      },
    ];

    for (const m of messages) {
      const existing = await prisma.chatMessage.findFirst({ where: { id: m.id } });
      if (!existing) {
        await prisma.chatMessage.create({
          data: {
            id: m.id,
            conversationId,
            senderType: "parent",
            senderId: parentId,
            text: m.text,
            createdAt: m.createdAt,
            readAt: null,
          },
        });
      }
    }

    const last = messages[messages.length - 1];
    await prisma.chatConversation.update({
      where: { id: conversationId },
      data: { lastMessage: last.text },
    });
  }

  // Existing dev data (keep)
  await seedParentAndPlayer({
    parentId: "parent-79991112233",
    phone: "79991112233",
    playerId: "player_1",
  });
  await seedSubscription("parent-79991112233");

  // Real app login dev data (add)
  await seedParentAndPlayer({
    parentId: "parent-79990001122",
    phone: "79990001122",
    playerId: "player_1_real",
  });
  await seedSubscription("parent-79990001122");

  await seedFeedPosts();
  await seedChat();

  await seedScheduleEvents();

  await seedMarketplace();

  await seedTrainingEvents();

  async function seedSubscriptionPlans() {
    const plans = [
      {
        id: "plan_basic",
        code: "basic",
        name: "Basic",
        priceMonthly: 0,
        priceYearly: 0,
        features: [],
        badge: "Demo",
        popular: true,
      },
      {
        id: "plan_premium",
        code: "premium",
        name: "Premium",
        priceMonthly: 499,
        priceYearly: 4990,
        features: ["AI Analysis", "Premium support"],
        badge: "Popular",
        popular: true,
      },
    ];

    await Promise.all(
      plans.map((p) =>
        prisma.subscriptionPlan.upsert({
          where: { code: p.code },
          update: {
            id: p.id,
            name: p.name,
            priceMonthly: p.priceMonthly,
            priceYearly: p.priceYearly,
            features: p.features,
            badge: p.badge,
            popular: p.popular,
          },
          create: {
            id: p.id,
            code: p.code,
            name: p.name,
            priceMonthly: p.priceMonthly,
            priceYearly: p.priceYearly,
            features: p.features,
            badge: p.badge,
            popular: p.popular,
          },
        })
      )
    );
  }

  await seedSubscriptionPlans();

  await prisma.$disconnect();
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exitCode = 1;
});

