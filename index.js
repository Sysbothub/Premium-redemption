// ========== COMPLETE BOT IN ONE FILE: index.js ==========
// BLOCK 1: IMPORTS AND INITIAL SETUP
const { Client, GatewayIntentBits, Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
//const express = require('express');
const bodyParser = require('body-parser');
const { AutoPoster } = require('topgg-autoposter');
//const mongoose = require('mongoose');
require('dotenv').config();

// ========== EXPRESS WEB SERVER SETUP ==========
const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// ========== DISCORD CLIENT SETUP ==========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const PREFIX = process.env.PREFIX || '!';
// BLOCK 2: MONGODB CONNECTION AND SETUP
const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('✅ Connected to MongoDB');
}).catch((err) => {
  console.error('❌ MongoDB connection error:', err);
});

// ========== MONGODB SCHEMAS ==========
const guildPremiumSchema = new mongoose.Schema({
  guildId: { type: String, unique: true, required: true },
  premiumRoleId: { type: String, default: null },
  premiumExpiresAt: { type: Date, default: null },
  redeemedCodes: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const voteSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String, required: true },
  totalVotes: { type: Number, default: 1 },
  lastVoteAt: { type: Date, default: Date.now },
  votedAt: { type: [Date], default: [Date.now()] },
  createdAt: { type: Date, default: Date.now },
});

voteSchema.index({ userId: 1 }, { unique: true });

const codeSchema = new mongoose.Schema({
  code: { type: String, unique: true, required: true },
  premiumDays: { type: Number, required: true },
  maxUses: { type: Number, default: 1 },
  currentUses: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const GuildPremium = mongoose.model('GuildPremium', guildPremiumSchema);
const Vote = mongoose.model('Vote', voteSchema);
const Code = mongoose.model('Code', codeSchema);
// BLOCK 3: UTILITY FUNCTIONS
function generateRandomCode() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 16; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return code;
}
// BLOCK 4: EXPRESS WEB SERVER ENDPOINTS - HEALTH CHECK
const express = require('express');
//const app = express();

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    bot: client.user?.tag || 'Bot starting...',
    timestamp: new Date().toISOString(),
    guilds: client.guilds.cache.size,
    uptime: process.uptime(),
  });
});

// Detailed status endpoint
app.get('/status', (req, res) => {
  const botStatus = {
    online: client.isReady(),
    username: client.user?.tag,
    id: client.user?.id,
    guilds: client.guilds.cache.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  };
  res.json(botStatus);
});
// BLOCK 5: TOP.GG WEBHOOK ENDPOINT
app.post('/topgg/webhook', (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || authHeader !== process.env.TOPGG_WEBHOOK_SECRET) {
    console.warn('⚠️ Unauthorized Top.gg webhook attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const userId = req.body.user;
  const voteType = req.body.type || 'upvote';
  
  console.log(`✅ Vote received from user: ${userId} (${voteType})`);
  client.emit('topggVote', { userId, voteType });

  res.status(200).json({ success: true, message: 'Vote processed' });
});
// BLOCK 6: API ENDPOINTS - PREMIUM SERVERS
app.get('/api/premium/servers', async (req, res) => {
  try {
    const servers = await GuildPremium.find({ premiumExpiresAt: { $gt: new Date() } });
    res.json({
      success: true,
      count: servers.length,
      servers: servers,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/premium/server/:guildId', async (req, res) => {
  try {
    const { guildId } = req.params;
    const server = await GuildPremium.findOne({ guildId });

    if (!server) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }

    const isActive = server.premiumExpiresAt && server.premiumExpiresAt > new Date();

    res.json({
      success: true,
      guildId: server.guildId,
      premiumActive: isActive,
      premiumExpiresAt: server.premiumExpiresAt,
      premiumRoleId: server.premiumRoleId,
      redeemedCodesCount: server.redeemedCodes.length,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// BLOCK 7: API ENDPOINTS - VOTES
app.get('/api/votes', async (req, res) => {
  try {
    const votes = await Vote.find().sort({ totalVotes: -1 });
    res.json({
      success: true,
      count: votes.length,
      votes: votes,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/votes/top/:limit', async (req, res) => {
  try {
    const { limit } = req.params;
    const topVoters = await Vote.find().sort({ totalVotes: -1 }).limit(parseInt(limit) || 10);

    res.json({
      success: true,
      count: topVoters.length,
      topVoters: topVoters,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/votes/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const voter = await Vote.findOne({ userId });

    if (!voter) {
      return res.status(404).json({ success: false, error: 'User not found in votes' });
    }

    res.json({
      success: true,
      userId: voter.userId,
      username: voter.username,
      totalVotes: voter.totalVotes,
      lastVoteAt: voter.lastVoteAt,
      voteHistory: voter.votedAt,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// BLOCK 8: API ENDPOINTS - CODES
app.get('/api/codes', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  Code.find().then((codes) => {
    res.json({
      success: true,
      count: codes.length,
      codes: codes,
    });
  }).catch((error) => {
    res.status(500).json({ success: false, error: error.message });
  });
});

app.get('/api/codes/:code', (req, res) => {
  const { code } = req.params;

  Code.findOne({ code: code.toUpperCase() }).then((codeDoc) => {
    if (!codeDoc) {
      return res.status(404).json({ success: false, error: 'Code not found' });
    }

    res.json({
      success: true,
      code: codeDoc.code,
      premiumDays: codeDoc.premiumDays,
      maxUses: codeDoc.maxUses,
      currentUses: codeDoc.currentUses,
      isActive: codeDoc.isActive,
      createdAt: codeDoc.createdAt,
    });
  }).catch((error) => {
    res.status(500).json({ success: false, error: error.message });
  });
});
// BLOCK 9: START WEB SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
  console.log(`📊 Status page: http://localhost:${PORT}`);
});
// BLOCK 10: TOP.GG SETUP
//const { AutoPoster } = require('topgg-autoposter');
const { client } = require('./index.js');

if (process.env.TOPGG_API_TOKEN) {
  const ap = new AutoPoster({
    token: process.env.TOPGG_API_TOKEN,
    client: client,
    interval: 1800000,
  });

  ap.on('posted', () => {
    console.log('📊 Server count posted to Top.gg');
  });

  ap.on('error', (error) => {
    console.error('❌ Autoposter error:', error);
  });
} else {
  console.warn('⚠️ TOPGG_API_TOKEN not set. Skipping autoposter.');
}
// BLOCK 11: VOTE REWARD HANDLER
client.on('topggVote', async (voteData) => {
  const { userId, voteType } = voteData;
  
  try {
    console.log(`🎁 Processing ${voteType} vote for user: ${userId}`);
    
    const discordUser = await client.users.fetch(userId).catch(() => null);
    
    if (!discordUser) {
      console.error(`❌ Could not fetch user ${userId}`);
      return;
    }

    let voteRecord = await Vote.findOne({ userId });
    
    if (!voteRecord) {
      voteRecord = new Vote({
        userId,
        username: discordUser.username,
        totalVotes: 1,
        lastVoteAt: new Date(),
        votedAt: [new Date()],
      });
    } else {
      voteRecord.totalVotes += 1;
      voteRecord.lastVoteAt = new Date();
      voteRecord.votedAt.push(new Date());
      voteRecord.username = discordUser.username;
    }

    await voteRecord.save();

    // Send thank you DM
    const thankYouEmbed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('✨ Thank You for Voting!')
      .setDescription(`Thank you for voting for our bot on Top.gg!`)
      .addFields(
        { name: '🗳️ Your Total Votes', value: voteRecord.totalVotes.toString(), inline: true },
        { name: '⏰ Last Vote', value: `<t:${Math.floor(voteRecord.lastVoteAt.getTime() / 1000)}:R>`, inline: true }
      )
      .setFooter({ text: 'Premium Redemption Bot' })
      .setTimestamp();

    await discordUser.send({ embeds: [thankYouEmbed] }).catch(() => {
      console.log(`⚠️ Could not DM user ${userId}`);
    });

    // Log vote in support server
    const supportServer = await client.guilds.fetch(process.env.SUPPORT_SERVER_ID).catch(() => null);
    if (supportServer) {
      const logChannel = await supportServer.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
      
      if (logChannel) {
        const voteLogEmbed = new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle('🗳️ New Vote Recorded')
          .addFields(
            { name: '👤 User', value: `${discordUser.username} (${userId})`, inline: true },
            { name: '🗳️ Total Votes', value: voteRecord.totalVotes.toString(), inline: true },
            { name: '⏰ Voted At', value: `<t:${Math.floor(new Date().getTime() / 1000)}:f>`, inline: false }
          )
          .setThumbnail(discordUser.displayAvatarURL())
          .setFooter({ text: 'Premium Redemption Bot' })
          .setTimestamp();

        await logChannel.send({ embeds: [voteLogEmbed] }).catch((err) => {
          console.error('❌ Error sending vote log:', err);
        });
      }
    }

    console.log(`✅ Vote processed successfully for user ${userId}`);
  } catch (error) {
    console.error('❌ Error processing vote:', error);
  }
});
// BLOCK 12: BOT READY EVENT
client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  console.log(`📊 Serving ${client.guilds.cache.size} guilds`);
});
// BLOCK 13: HELP COMMAND
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();

  try {
    if (commandName === 'help') {
      const helpEmbed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('📚 Bot Commands')
        .setDescription(`Use **${PREFIX}** before each command`)
        .addFields(
          { name: '🗳️ vote', value: 'Vote for the bot on Top.gg' },
          { name: '💳 premium', value: 'Check your server\'s premium status' },
          { name: '💎 redeem', value: `${PREFIX}redeem <code> - Redeem a premium code for this server` },
          { name: '🎁 gencodes', value: `${PREFIX}gencodes - Bot Owner Only: Generate 15 premium codes (31 days each)` },
          { name: '📋 listcodes', value: 'bot Owner Only: List all active codes' },
          { name: '❌ deactivatecode', value: `${PREFIX}deactivatecode <code> - Bot Owner Only: Deactivate a code` },
          { name: '🏆 leaderboard', value: 'View top voters' },
          { name: '📊 voterinfo', value: `${PREFIX}voterinfo <userId> - View voter statistics` },
          { name: '📞 support', value: 'Get support server link' },
          { name: '⏱️ ping', value: 'Check bot latency' }
        )
        .setFooter({ text: 'Miraidon Premium Redemption Bot' })
        .setTimestamp();

      return message.reply({ embeds: [helpEmbed], allowedMentions: { repliedUser: false } });
    }
  } catch (error) {
    console.error('❌ Command error:', error);
  }
});
// BLOCK 14: VOTE COMMAND
if (commandName === 'vote') {
  const voteEmbed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('🗳️ Vote for Miraidon!')
    .setDescription('Vote for our bot on Top.gg!')
    .addFields(
      { name: '📌 Support Miraidon', value: 'Help us grow by voting every 12 hours!' },
      { name: '⏱️ Vote Cooldown', value: '12 hours per vote' }
    );

  const voteButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Vote on Top.gg')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://top.gg/bot/${client.user.id}/vote`)
  );

  return message.reply({ 
    embeds: [voteEmbed], 
    components: [voteButton],
    allowedMentions: { repliedUser: false } 
  });
}
// BLOCK 15: REDEEM COMMAND
if (commandName === 'redeem') {
  if (!args[0]) {
    return message.reply({
      content: `❌ Usage: ${PREFIX}redeem <code>`,
      allowedMentions: { repliedUser: false }
    });
  }

  const code = args[0].toUpperCase();
  const guildId = message.guildId;
  
  let guildPremium = await GuildPremium.findOne({ guildId });

  if (!guildPremium) {
    guildPremium = new GuildPremium({ guildId });
    await guildPremium.save();
  }

  // Check if code already redeemed
  if (guildPremium.redeemedCodes.includes(code)) {
    return message.reply({
      content: '❌ This code has already been redeemed for this server!',
      allowedMentions: { repliedUser: false }
    });
  }

  // Find code in database
  const premiumCode = await Code.findOne({ code, isActive: true });

  if (!premiumCode) {
    return message.reply({
      content: '❌ Invalid or inactive code.',
      allowedMentions: { repliedUser: false }
    });
  }

  // Check if code has reached max uses
  if (premiumCode.currentUses >= premiumCode.maxUses) {
    return message.reply({
      content: '❌ This code has already been used.',
      allowedMentions: { repliedUser: false }
    });
  }

  // Show modal to ask for role ID
  const modal = new ModalBuilder()
    .setCustomId(`premiumModal_${code}`)
    .setTitle('Setup Server Premium')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('roleId')
          .setLabel('Premium Role ID')
          .setPlaceholder('Enter the role ID to give premium members')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );

  await message.showModal(modal);
  return;
}
// BLOCK 16: PREMIUM COMMAND
if (commandName === 'premium') {
  const guildId = message.guildId;
  let guildPremium = await GuildPremium.findOne({ guildId });

  if (!guildPremium) {
    guildPremium = new GuildPremium({ guildId });
    await guildPremium.save();
  }

  const status = guildPremium.premiumExpiresAt && guildPremium.premiumExpiresAt > new Date() ? '✅ Active' : '❌ Inactive';
  const expiryDate = guildPremium.premiumExpiresAt ? new Date(guildPremium.premiumExpiresAt).toLocaleDateString() : 'Never expires';
  const daysLeft = guildPremium.premiumExpiresAt && guildPremium.premiumExpiresAt > new Date()
    ? Math.ceil((guildPremium.premiumExpiresAt - Date.now()) / (1000 * 60 * 60 * 24))
    : 0;

  const roleInfo = guildPremium.premiumRoleId ? `<@&${guildPremium.premiumRoleId}>` : 'Not configured';

  const premiumEmbed = new EmbedBuilder()
    .setColor(guildPremium.premiumExpiresAt && guildPremium.premiumExpiresAt > new Date() ? '#FFD700' : '#ff0000')
    .setTitle('💳 Server Premium Status')
    .addFields(
      { name: 'Status', value: status, inline: true },
      { name: 'Expires On', value: expiryDate, inline: true },
      { name: 'Days Remaining', value: daysLeft.toString(), inline: true },
      { name: '🎯 Premium Role', value: roleInfo, inline: false },
      { name: '📍 Server', value: message.guild.name, inline: true }
    )
    .setFooter({ text: 'Miraidon Premium redemption Bot' })
    .setTimestamp();

  return message.reply({ embeds: [premiumEmbed], allowedMentions: { repliedUser: false } });
}
// BLOCK 17: GENCODES COMMAND
if (commandName === 'gencodes') {
  if (message.author.id !== process.env.ADMIN_USER_ID) {
    return message.reply({
      content: '❌ You do not have permission to use this command.',
      allowedMentions: { repliedUser: false }
    });
  }

  const amount = 15;

  const generatedCodes = [];
  const failedCodes = [];

  const loadingMsg = await message.reply({
    content: `⏳ Generating ${amount} codes...`,
    allowedMentions: { repliedUser: false }
  });

  for (let i = 0; i < amount; i++) {
    let code = generateRandomCode();
    let attempts = 0;

    while (await Code.findOne({ code }) && attempts < 10) {
      code = generateRandomCode();
      attempts++;
    }

    if (attempts >= 10) {
      failedCodes.push(`Code ${i + 1}`);
      continue;
    }

    const newCode = new Code({
      code,
      premiumDays: 31,
      maxUses: 1,
      createdBy: message.author.id,
    });

    try {
      await newCode.save();
      generatedCodes.push(code);
    } catch (error) {
      console.error(`❌ Failed to save code ${code}:`, error);
      failedCodes.push(code);
    }
  }

  await loadingMsg.edit({
    content: `✅ Generated ${generatedCodes.length} codes!`,
    allowedMentions: { repliedUser: false }
  });

  const dmEmbed = new EmbedBuilder()
    .setColor('#00ff00')
    .setTitle('🎁 Generated 15 Premium Codes')
    .setDescription(`15 unique codes generated\n**Duration:** 31 days after redemption\n**Total Generated:** ${generatedCodes.length}`)
    .addFields(
      { 
        name: '📋 Codes', 
        value: generatedCodes.join('\n') || 'No codes generated',
        inline: false 
      }
    );

  if (failedCodes.length > 0) {
    dmEmbed.addFields({
      name: '⚠️ Failed',
      value: `${failedCodes.length} codes failed to generate`,
      inline: false
    });
  }

  dmEmbed
    .setFooter({ text: 'Premium Redemption Bot' })
    .setTimestamp();

  try {
    await message.author.send({
      content: '🎁 **Your Generated Premium Codes**',
      embeds: [dmEmbed]
    });

    await message.reply({
      content: `✅ Generated and sent **${generatedCodes.length}** codes to your DMs!`,
      allowedMentions: { repliedUser: false }
    });
  } catch (error) {
    console.error('❌ Error sending DM:', error);
    await message.reply({
      content: `⚠️ Generated ${generatedCodes.length} codes, but couldn't send DM. Check your privacy settings.`,
      allowedMentions: { repliedUser: false }
    });
  }
}
// BLOCK 18: LISTCODES COMMAND
if (commandName === 'listcodes') {
  if (message.author.id !== process.env.ADMIN_USER_ID) {
    return message.reply({
      content: '❌ You do not have permission to use this command.',
      allowedMentions: { repliedUser: false }
    });
  }

  const codes = await Code.find({ isActive: true });

  if (codes.length === 0) {
    return message.reply({
      content: '❌ No active codes found.',
      allowedMentions: { repliedUser: false }
    });
  }

  let codesList = '';
  codes.forEach((code, index) => {
    const usageInfo = `${code.currentUses}/${code.maxUses} uses`;
    codesList += `${index + 1}. \`${code.code}\` - ${code.premiumDays} days - ${usageInfo}\n`;
  });

  const chunks = codesList.match(/[\s\S]{1,1900}/g) || [];

  for (let i = 0; i < chunks.length; i++) {
    const listEmbed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('📋 Active Codes')
      .setDescription(chunks[i])
      .setFooter({ text: `Page ${i + 1} of ${chunks.length} | Total: ${codes.length} codes` })
      .setTimestamp();

    await message.reply({ embeds: [listEmbed], allowedMentions: { repliedUser: false } });
  }
}
// BLOCK 19: DEACTIVATECODE COMMAND
if (commandName === 'deactivatecode') {
  if (message.author.id !== process.env.ADMIN_USER_ID) {
    return message.reply({
      content: '❌ You do not have permission to use this command.',
      allowedMentions: { repliedUser: false }
    });
  }

  if (!args[0]) {
    return message.reply({
      content: `❌ Usage: ${PREFIX}deactivatecode <code>`,
      allowedMentions: { repliedUser: false }
    });
  }

  const code = await Code.findOne({ code: args[0].toUpperCase() });

  if (!code) {
    return message.reply({
      content: '❌ Code not found.',
      allowedMentions: { repliedUser: false }
    });
  }

  code.isActive = false;
  await code.save();

  const deactEmbed = new EmbedBuilder()
    .setColor('#ff0000')
    .setTitle('✅ Code Deactivated')
    .addFields(
      { name: '🎫 Code', value: code.code, inline: true },
      { name: '📊 Uses', value: `${code.currentUses}/${code.maxUses}`, inline: true }
    )
    .setFooter({ text: 'Premium Redemption Bot' })
    .setTimestamp();

  return message.reply({ embeds: [deactEmbed], allowedMentions: { repliedUser: false } });
}
// BLOCK 20: LEADERBOARD COMMAND
if (commandName === 'leaderboard') {
  const topVoters = await Vote.find().sort({ totalVotes: -1 }).limit(10);

  if (topVoters.length === 0) {
    return message.reply({
      content: '❌ No votes recorded yet.',
      allowedMentions: { repliedUser: false }
    });
  }

  let leaderboardText = '';
  for (let i = 0; i < topVoters.length; i++) {
    const voter = topVoters[i];
    leaderboardText += `${i + 1}. **${voter.username}** (${voter.userId}) - ${voter.totalVotes} votes\n`;
  }

  const leaderboardEmbed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('🏆 Top Voters')
    .setDescription(leaderboardText)
    .setFooter({ text: 'Miraidon trade Bot' })
    .setTimestamp();

  return message.reply({ embeds: [leaderboardEmbed], allowedMentions: { repliedUser: false } });
}
// BLOCK 21: VOTERINFO COMMAND (COMPLETE)
if (commandName === 'voterinfo') {
  if (!args[0]) {
    return message.reply({
      content: `❌ Usage: ${PREFIX}voterinfo <userId>`,
      allowedMentions: { repliedUser: false }
    });
  }

  const userId = args[0].replace(/[<@!>]/g, '');
  const voteRecord = await Vote.findOne({ userId });

  if (!voteRecord) {
    return message.reply({
      content: '❌ This user has not voted yet.',
      allowedMentions: { repliedUser: false }
    });
  }

  const voteTimes = voteRecord.votedAt
    .slice(-5)
    .reverse()
    .map((date, index) => `${index + 1}. <t:${Math.floor(date.getTime() / 1000)}:f>`)
    .join('\n');

  const voterInfoEmbed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('🗳️ Voter Statistics')
    .addFields(
      { name: '👤 Username', value: voteRecord.username, inline: true },
      { name: '🆔 User ID', value: userId, inline: true },
      { name: '📊 Total Votes', value: voteRecord.totalVotes.toString(), inline: true },
      { name: '⏰ Last Vote', value: `<t:${Math.floor(voteRecord.lastVoteAt.getTime() / 1000)}:R>`, inline: true },
      { name: '📅 Last 5 Votes', value: voteTimes || 'No vote history', inline: false }
    )
    .setFooter({ text: 'Miraidon Trade Bot' })
    .setTimestamp();

  return message.reply({ embeds: [voterInfoEmbed], allowedMentions: { repliedUser: false } });
}
// BLOCK 22: SUPPORT COMMAND
if (commandName === 'support') {
  const supportEmbed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle('📞 Need Help?')
    .setDescription('Join our support server for assistance!')
    .addFields(
      { name: '🔗 Support Server', value: 'https://discord.gg/pkm-universe' }
    )
    .setFooter({ text: 'Miraidon Trading Bot' })
    .setTimestamp();

  return message.reply({ embeds: [supportEmbed], allowedMentions: { repliedUser: false } });
}
// BLOCK 23: PING COMMAND
if (commandName === 'ping') {
  const ping = Date.now() - message.createdTimestamp;
  const apiPing = Math.round(client.ws.ping);

  const pingEmbed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle('⏱️ Bot Latency')
    .addFields(
      { name: 'Message Latency', value: `${ping}ms`, inline: true },
      { name: 'API Latency', value: `${apiPing}ms`, inline: true }
    )
    .setFooter({ text: 'Premium Redemption Bot' })
    .setTimestamp();

  return message.reply({ embeds: [pingEmbed], allowedMentions: { repliedUser: false } });
}
// BLOCK 24: UNKNOWN COMMAND HANDLER
    // Unknown command
    return message.reply({
      content: `❌ Unknown command! Use ${PREFIX}help for a list of commands.`,
      allowedMentions: { repliedUser: false }
    });

  } catch (error) {
    console.error('❌ Command error:', error);
    return message.reply({
      content: '❌ An error occurred while executing this command.',
      allowedMentions: { repliedUser: false }
    });
  }
});
// BLOCK 25: MODAL SUBMISSION HANDLER
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isModalSubmit()) return;

  try {
    const customId = interaction.customId;

    // Handle premium code redemption modal
    if (customId.startsWith('premiumModal_')) {
      const code = customId.replace('premiumModal_', '');
      const roleId = interaction.fields.getTextInputValue('roleId');
      const guildId = interaction.guildId;

      // Verify role exists
      try {
        await interaction.guild.roles.fetch(roleId);
      } catch (err) {
        return interaction.reply({
          content: '❌ Role not found. Please provide a valid role ID.',
          ephemeral: true
        });
      }

      let guildPremium = await GuildPremium.findOne({ guildId });

      if (!guildPremium) {
        guildPremium = new GuildPremium({ guildId });
      }

      // Check if code already redeemed
      if (guildPremium.redeemedCodes.includes(code)) {
        return interaction.reply({
          content: '❌ This code has already been redeemed for this server!',
          ephemeral: true
        });
      }

      // Find code in database
      const premiumCode = await Code.findOne({ code, isActive: true });

      if (!premiumCode) {
        return interaction.reply({
          content: '❌ Invalid or inactive code.',
          ephemeral: true
        });
      }

      // Check if code has reached max uses
      if (premiumCode.currentUses >= premiumCode.maxUses) {
        return interaction.reply({
          content: '❌ This code has already been used.',
          ephemeral: true
        });
      }

      // Calculate expiry date: 31 days from now (redemption time)
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 31);

      guildPremium.premiumRoleId = roleId;
      guildPremium.premiumExpiresAt = expiryDate;
      guildPremium.redeemedCodes.push(code);
      guildPremium.updatedAt = new Date();
      await guildPremium.save();

      // Update code usage
      premiumCode.currentUses += 1;
      await premiumCode.save();

      // Log Premium Activation to Support Server
      const premiumLogEmbed = new EmbedBuilder()
        .setColor('#00AAFF')
        .setTitle('🟦 Premium Activated')
        .addFields(
          { name: '📛 Server Name', value: interaction.guild.name, inline: true },
          { name: '🆔 Server ID', value: interaction.guild.id, inline: true },
          { name: '⏳ Duration', value: '31 days', inline: true },
          { name: '🎯 Role ID', value: roleId, inline: true },
          { name: '🎫 Code', value: code, inline: true },
          { name: '👤 Redeemed By', value: `${interaction.user.tag}`, inline: false },
          { name: '⏰ Expires', value: `<t:${Math.floor(expiryDate.getTime() / 1000)}:f>`, inline: false }
        )
        .setDescription(`**Support:** https://discord.gg/pkm-universe`)
        .setFooter({ text: 'Premium Redemption Bot' })
        .setTimestamp();

      // Send to support log channel
      try {
        const supportServer = await client.guilds.fetch(process.env.SUPPORT_SERVER_ID).catch(() => null);
        if (supportServer) {
          const logChannel = await supportServer.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
          if (logChannel?.isTextBased()) {
            await logChannel.send({ embeds: [premiumLogEmbed] });
            console.log(`✅ Premium activation logged for ${interaction.guild.name}`);
          }
        }
      } catch (error) {
        console.error('❌ Premium log failed:', error.message);
      }

      // Send confirmation DM to user
      try {
        const dmEmbed = new EmbedBuilder()
          .setColor('#00ff00')
          .setTitle('✅ Premium Activated!')
          .addFields(
            { name: '📛 Server', value: interaction.guild.name, inline: true },
            { name: '⏳ Duration', value: '31 days', inline: true },
            { name: '📅 Expires', value: `<t:${Math.floor(expiryDate.getTime() / 1000)}:f>`, inline: false },
            { name: '🎯 Role', value: `<@&${roleId}>`, inline: false }
          )
          .setFooter({ text: 'Premium Redemption Bot' })
          .setTimestamp();

        await interaction.user.send({ embeds: [dmEmbed] });
      } catch (e) {
        console.log(`⚠️ Could not DM user ${interaction.user.id}`);
      }

      // Send confirmation to server
      const redeemEmbed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle('✅ Premium Activated for Server!')
        .addFields(
          { name: '🎫 Code', value: code, inline: true },
          { name: '⏳ Duration', value: '31 days', inline: true },
          { name: '⏰ Expires', value: `<t:${Math.floor(expiryDate.getTime() / 1000)}:f>`, inline: false },
          { name: '🎯 Premium Role', value: `<@&${roleId}>`, inline: true },
          { name: '📍 Server', value: interaction.guild.name, inline: true }
        )
        .setFooter({ text: 'Miraidon Premium reemtion log' })
        .setTimestamp();

      return interaction.reply({
        embeds: [redeemEmbed],
        ephemeral: false
      });
    }
  } catch (error) {
    console.error('❌ Modal handler error:', error);
    return interaction.reply({
      content: '❌ An error occurred while processing your request.',
      ephemeral: true
    });
  }
});
// BLOCK 26: BOT LOGIN
client.login(process.env.DISCORD_TOKEN);

module.exports = { client, PREFIX };
