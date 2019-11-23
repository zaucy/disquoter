import Discord from 'discord.js';
import Fuse from 'fuse.js';
import download from 'download';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as chokidar from 'chokidar';
import config from 'config';
import fileType from 'file-type';
import * as child_process from 'child_process';

const AUDIO_FILES_DIR = config.get<string>('audio_files_path');
const DISCORD_CLIENT_TOKEN = config.get<string>('discord_client_token');
const DISCORD_CLIENT_ID = config.get<string>('discord_client_id');
const DCA_CMD_PATH = config.get<string>('dca_cmd_path');
const DCA_CMD_ARGS = config.get<string[]>('dca_cmd_args');
const CHANNEL_VARS_PATH = config.get<string>('channel_vars_path');

interface IOuijaCharInfo {
  char: string;
  author: Discord.Snowflake;
}

interface IChannelVars {
  ouijaChars: IOuijaCharInfo[];
}

interface IChannelVarsMap {
  [key: string]: IChannelVars;
}

interface IAudioFileInfo {
  filename: string;
}

interface IPlayQueueItem {
  audioFilename: string;
  voiceChannel: Discord.VoiceChannel;
}

const defaultChannelVars: IChannelVars = {
  ouijaChars: [],
};

let audioFiles: string[] = [];
const audioFuse = new Fuse<IAudioFileInfo, Fuse.FuseOptions<any>>([], {
  caseSensitive: false,
  keys: [
    'filename',
  ],
});

const playQueue: IPlayQueueItem[] = [];

async function _readChannelVarsMap(): Promise<IChannelVarsMap> {
  if(!await fs.pathExists(CHANNEL_VARS_PATH)) {
    return {};
  }

  try {
    return await fs.readJson(CHANNEL_VARS_PATH);
  } catch(err) {
    console.warn('Error while reading channel vars json:', err.message);
    return {};
  }
}

async function loadChannelVar(channelName: string): Promise<IChannelVars> {
  const channelVarsMap = await _readChannelVarsMap();
  let vars = channelVarsMap[channelName];

  if(!vars) {
    vars = defaultChannelVars;
  }

  return vars;
}

async function storeChannelVar(channelName, vars: IChannelVars) {
  const channelVarsMap = await _readChannelVarsMap();
  channelVarsMap[channelName] = vars;
  await fs.writeJson(CHANNEL_VARS_PATH, channelVarsMap);
}

async function ensureVoiceConnection
  ( voiceChannel: Discord.VoiceChannel
  ): Promise<Discord.VoiceConnection>
{

  for(const voiceCon of voiceChannel.client.voiceConnections.values()) {
    if(voiceCon.channel.id == voiceChannel.id) {
      // Use existing voice connection
      return voiceCon;
    }
  }

  // Create new voice connection
  return await voiceChannel.join();
}

async function doPlayAudioInVoiceChannel() {
  const queueItem = playQueue[playQueue.length - 1];

  if(!queueItem) {
    return;
  }

  const audioFilename = queueItem.audioFilename;
  const dcaFilename = path.basename(audioFilename, path.extname(audioFilename)) + ".dca";
  const voiceChannel = queueItem.voiceChannel;

  const audioFilePath = path.resolve(AUDIO_FILES_DIR, audioFilename);
  const dcaFilePath = path.resolve(AUDIO_FILES_DIR, dcaFilename);

  const voiceConnection = await ensureVoiceConnection(voiceChannel);

  let dispatcher: Discord.StreamDispatcher;

  if(DCA_CMD_PATH && await fs.pathExists(dcaFilePath)) {
    const readStream = fs.createReadStream(dcaFilePath)
    dispatcher = voiceConnection.playOpusStream(readStream);
  } else {
    dispatcher = voiceConnection.playFile(audioFilePath);
  }

  await new Promise((resolve, reject) => {
    dispatcher.once('error', reject);
    dispatcher.on("speaking", value => {
      if(!value) {
        resolve();
      }
    });
  });

  playQueue.pop();

  if(playQueue.length == 0) {
    voiceChannel.leave();
  } else {
    await doPlayAudioInVoiceChannel();
  }
}

async function writeDcaFile(filepath: string, audioFilePath: string) {

  if(!await fs.pathExists(DCA_CMD_PATH)) {
    console.warn('[warn] dca cmd path file does not exist. dca files will not be created');
    return;
  }

  const writeStream = await fs.open(filepath, 'w');
  const readStream = await fs.open(audioFilePath, 'r');

  const child = child_process.spawn(DCA_CMD_PATH, DCA_CMD_ARGS, {
    stdio: [
      readStream,
      writeStream,
    ],
  });

  await new Promise((resolve, reject) => {
    child.on('close', () => Promise.all([
        fs.close(writeStream),
        fs.close(readStream),
      ]).then(resolve, reject)
    );
  });
}

function playAudioInVoiceChannel
  ( audioName: string
  , channel: Discord.VoiceChannel
  )
{
  playQueue.unshift({
    audioFilename: audioName,
    voiceChannel: channel,
  });

  if(playQueue.length == 1) {
    doPlayAudioInVoiceChannel();
  }
}

async function doAudioSearchAndPlay
  ( msg: Discord.Message
  , searchString: string
  )
{
  const results = audioFuse.search(searchString);

  if(results.length > 0) {
    const result = results[0];

    for(const guild of msg.client.guilds.values()) {
      const member = guild.member(msg.author);

      if(member && member.voiceChannel) {
        await playAudioInVoiceChannel(
          result['filename'],
          member.voiceChannel,
        );
      } else {
        await msg.reply(`I would have played '${result['filename']}', but you are not in a voice channel!`);
      }
    }

  } else {
    await msg.reply(`Couldn't find anything that matches '${searchString}'`);
  }
}

async function messageHandler(msg: Discord.Message) {

  // Ignore out own messages
  if(msg.author.id == DISCORD_CLIENT_ID) {
    return;
  }

  const trimmedContent = msg.content.trim();
  let vars = await loadChannelVar(msg.channel.id);

  if(msg.channel.type == 'dm') {

    const processAttachments = async () => {
      for await(const attachment of msg.attachments.values()) {
        const filename = attachment.filename.toLowerCase();
  
        const localPath = path.resolve(AUDIO_FILES_DIR, filename);
        const localDcaPath = path.resolve(
          AUDIO_FILES_DIR,
          path.basename(filename, path.extname(filename)) + '.dca',
        );
  
        const pathExists = await fs.pathExists(localPath);
        if(pathExists) {
          await msg.reply(`Attachment with name '${filename}' already exists. If you would like to upload this file please rename it.`);
          return;
        }
  
        const attachmentData = await download(attachment.url);
        const attachmentFileType = fileType(attachmentData);
  
        if(!attachmentFileType || !attachmentFileType.mime) {
          await msg.reply(`Unable to find mime type for attachment: ${filename}`);
        } else if(attachmentFileType.mime.startsWith('audio/')) {
          await fs.writeFile(localPath, attachmentData);
          if(DCA_CMD_PATH) {
            await writeDcaFile(localDcaPath, localPath);
          }
          await msg.reply(`'${filename}' is now available for your disquoter enjoyment!`);
        } else {
          await msg.reply(`${filename} is not an audio file`);
        }
      }
    };

    const processMessage = async () => {
      if(trimmedContent) switch(trimmedContent) {
        case '!version':
          return msg.reply('0.1.0');
        case '!list':
          const formattedFilenames = audioFiles.map(f => ' - `' + f + '`').join('\n')
          return msg.reply(`**Available audio files**:\n${formattedFilenames}`);
        default:
          return doAudioSearchAndPlay(msg, trimmedContent)
            .catch(console.error);
      }
    };

    await Promise.all([
      processAttachments(),
      processMessage(),
    ]);

    // We didn't change any channel vars
    return;
  } else if(msg.channel.type == 'text') {
    if(trimmedContent.length === 1) {
      const lastCharInfo = vars.ouijaChars[vars.ouijaChars.length - 1];

      if(!lastCharInfo || lastCharInfo.author != msg.author.id) {
        vars.ouijaChars.push({
          char: trimmedContent,
          author: msg.author.id,
        });
      } else {
        await msg.delete();
        await msg.author.send(`Ouija says you may not post more than 1 character in a row`);
      }
    } else
    if(trimmedContent.toLowerCase() == 'goodbye') {
      const ouijaText = vars.ouijaChars.map(info => info.char).join('');

      if(ouijaText) {
        const sentMsg = <Discord.Message>await msg.channel.send(ouijaText, {
          tts: true,
        });

        vars.ouijaChars = [];
      } else {
        return;
      }
    } else {
      // Nothing to do with message
      return;
    }
  }

  await storeChannelVar(msg.channel.id, vars);
}

export async function runDisquoter() {
  const client = new Discord.Client();
  client.on('message', msg => {
    messageHandler(msg).catch(err => {
      console.error('Error while handling message:', err);
    });
  });

  if(!await fs.pathExists(AUDIO_FILES_DIR)) {
    console.log(`Creating audio files directory: ${path.resolve(AUDIO_FILES_DIR)}`);
    await fs.ensureDir(AUDIO_FILES_DIR);
  } else {
    const watcher = chokidar.watch(AUDIO_FILES_DIR);
    let timeout: any;

    watcher.on('all', () => {
      clearTimeout(timeout);

      timeout = setTimeout(async () => {
        console.log('Refreshing audio files list...');
        audioFiles = await fs.readdir(AUDIO_FILES_DIR);
        audioFuse.setCollection(audioFiles.map(filename => {
          return {filename};
        }));
      }, 1000);
    });
  }

  await client.login(DISCORD_CLIENT_TOKEN);
  console.log('Disquoter is running! Waiting for messages...');
}
