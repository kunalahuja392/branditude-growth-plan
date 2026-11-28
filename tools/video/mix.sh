#!/bin/bash
# mix.sh <key> <semitone>  : music + voice-over onto web/assets/video/<key>.mp4 (silent render)
set -e
K=$1; S=$2; T=/home/claude/bgp2/tools/video; V=/home/claude/bgp2/web/assets/video
DUR=$(python3 -c "import json;print(json.load(open('/home/claude/vid/durations.json'))['$K'])")
python3 $T/music.py m_$K.wav $DUR $S >/dev/null
STARTS=$(python3 -c "
import json;D=json.load(open('/home/claude/vid/scenes.json'))['$K'];t=0;o=[]
for d in D: o.append(int((t+0.35)*1000)); t+=d
print(' '.join(map(str,o)))")
IN=""; F=""; i=0
for s in $STARTS; do IN="$IN -i $T/voice/${K}_$i.mp3"; F="$F[$((i+1)):a]aresample=44100,adelay=${s}|${s}[v$i];"; i=$((i+1)); done
F="${F}[v0][v1][v2][v3][v4][v5][v6]amix=inputs=7:normalize=0,loudnorm=I=-15:TP=-1.5[vo];[0:a]loudnorm=I=-15:TP=-1.5,volume=-15dB[mu];[mu][vo]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.9[out]"
ffmpeg -v error -y -i m_$K.wav $IN -filter_complex "$F" -map "[out]" -ac 2 -ar 44100 mix_$K.wav
ffmpeg -v error -y -i $V/$K.mp4 -i mix_$K.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 128k -shortest -movflags +faststart $V/$K.tmp.mp4 && mv $V/$K.tmp.mp4 $V/$K.mp4
echo "$K ok $(ffprobe -v error -show_entries format=duration -of csv=p=0 $V/$K.mp4)"
