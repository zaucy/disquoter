import Discord from 'discord.js';
import Fuse from 'fuse.js';
import download from 'download';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as chokidar from 'chokidar';
import config from 'config';
import fileType from 'file-type';

const AUDIO_FILES_DIR = config.get<string>('audio_files_path');

const DISCORD_CLIENT_TOKEN = config.get<string>('discord_client_token');
const DISCORD_CLIENT_ID = config.get<string>('discord_client_id');

interface IOuijaCharInfo {
  char: string;
  author: Discord.Snowflake;
}

interface IChannelVars {
  ouijaChars: IOuijaCharInfo[];
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

const audioFuse = new Fuse<IAudioFileInfo>([], {
  caseSensitive: false,
  keys: [
    'filename',
  ],
});

const playQueue: IPlayQueueItem[] = [];

let _channelVars = new Map<string, IChannelVars>();

function loadChannelVar(channelName: string): IChannelVars {
  let vars = _channelVars.get(channelName);

  if(!vars) {
    vars = defaultChannelVars;
  }

  return vars;
}

function storeChannelVar(channelName, vars: IChannelVars) {
  _channelVars.set(channelName, vars);
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
  const voiceChannel = queueItem.voiceChannel;

  const audioFilePath = path.resolve(AUDIO_FILES_DIR, audioFilename);
  
  const voiceConnection = await ensureVoiceConnection(voiceChannel);
  const dispatcher = voiceConnection.playFile(audioFilePath);

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
    for(const guild of msg.client.guilds.values()) {
      const member = guild.member(msg.author);

      if(member && member.voiceChannel) {
        await playAudioInVoiceChannel(
          results[0].filename,
          member.voiceChannel,
        );
      } else {
        await msg.reply(`Would have played '${results[0].filename}', but you are not in a voice channel!`);
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
  let vars = loadChannelVar(msg.channel.id);

  if(msg.channel.type == 'dm') {

    if(trimmedContent) {
      // Fire and forget!
      (() => {doAudioSearchAndPlay(msg, trimmedContent)})();
    }

    for await(const attachment of msg.attachments.values()) {
      const filename = attachment.filename.toLowerCase();

      const localPath = path.resolve(AUDIO_FILES_DIR, filename);
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
        await msg.reply(`'${filename}' is now available for your disquoter enjoyment!`);
      } else {
        await msg.reply(`${filename} is not an audio file`);
      }
    }

    if(trimmedContent === 'version') {
      await msg.reply('0.1.0');
      return;
    }

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

  storeChannelVar(msg.channel.id, vars);
}

async function main() {
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
        const files = await fs.readdir(AUDIO_FILES_DIR);
        audioFuse.setCollection(files.map(filename => {
          return {filename};
        }));
      }, 1000);
    });
  }

  await client.login(DISCORD_CLIENT_TOKEN);
  console.log('Disquoter is running! Waiting for messages...');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
