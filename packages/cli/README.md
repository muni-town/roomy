# Roomy CLI

A command-line interface for sending messages to Roomy spaces.

## Installation

```bash
npm install -g roomy-cli
```

## Usage

### Authentication

First, you need to authenticate with your Roomy account:

```bash
roomy login
```

### Sending Messages

Send a simple message:

```bash
roomy send -s "Space Name" -c "Channel Name" -m "Hello, world!"
```

### Sending Messages with Images

Upload and send an image with a message:

```bash
roomy send -s "Space Name" -c "Channel Name" -m "Check out this image!" -i "/path/to/image.jpg"
```

Send just an image without text:

```bash
roomy send -s "Space Name" -c "Channel Name" -i "/path/to/image.jpg"
```

### Image Upload Options

Control image processing:

```bash
# Set maximum image size (default: 2048px)
roomy send -s "Space Name" -c "Channel Name" -i "/path/to/image.jpg" --max-size 1024

# Set image quality (default: 85)
roomy send -s "Space Name" -c "Channel Name" -i "/path/to/image.jpg" --quality 90
```

### Supported Image Formats

- JPEG (.jpg, .jpeg)
- PNG (.png)
- GIF (.gif)
- WebP (.webp)
- BMP (.bmp)

### Other Options

- `-t, --thread <thread>`: Reply in a specific thread
- `-r, --reply <messageId>`: Reply to a specific message
- `-w, --worker <handle>`: Use a Jazz Server Worker

### Examples

```bash
# Send a message with an image in a specific thread
roomy send -s "My Space" -c "general" -m "Here's the screenshot" -i "screenshot.png" -t "thread-123"

# Reply to a message with an image
roomy send -s "My Space" -c "general" -i "response.jpg" -r "msg-456"

# Use a Jazz Server Worker
roomy send -w "my-worker" -s "My Space" -c "general" -m "Hello from worker!" -i "image.jpg"
```

## Features

- ✅ Send text messages to Roomy spaces
- ✅ Upload and send images
- ✅ Reply to messages and threads
- ✅ Interactive space and channel selection
- ✅ Image processing and optimization
- ✅ Jazz Server Worker support
- ✅ Multiple image format support

## Image Processing

Images are automatically processed to:
- Resize to a maximum dimension (default: 2048px)
- Convert to JPEG format for consistency
- Create a placeholder thumbnail
- Optimize file size while maintaining quality

## Error Handling

The CLI provides clear error messages for:
- Authentication issues
- Invalid image formats
- File size limits (max 10MB)
- Network connectivity problems
- Missing spaces or channels 