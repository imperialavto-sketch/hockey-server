const { PrismaClient } = require("@prisma/client");

const globalForPrisma = global;

const isProduction = process.env.NODE_ENV === "production";
const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: isProduction ? ["error"] : ["query"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

module.exports = prisma;