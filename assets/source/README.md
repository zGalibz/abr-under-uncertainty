# Source media

## Frozen source

- Local filename: `source.mp4`
- Project path: `assets/source/source.mp4`
- License claim supplied by project owner: public domain
- Original source URL: intentionally not recorded at the project owner’s request
- SHA-256: `fda77d579859928e9c4134dc7a66eacc69cbeaed2860668130bfce05ac995dc1`
- Container: MP4 (`mov,mp4,m4a,3gp,3g2,mj2` family)
- Duration: `128.568889` seconds
- File size: `57,252,365` bytes
- Video: H.264, 1920×1080, 25 fps, `yuv420p`
- Audio: AAC, stereo, 44,100 Hz

## Deterministic processing

The packaging pipeline converts the source to constant 30 fps, resamples audio to 48,000 Hz, and generates aligned two-second HLS segments in four renditions. The original source remains unchanged and is excluded from ordinary Git history by `.gitignore`.

Verify the local source before packaging:

```bash
shasum -a 256 assets/source/source.mp4
ffprobe -v error \
  -show_entries format=duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt,channels,sample_rate \
  -of json assets/source/source.mp4
```
