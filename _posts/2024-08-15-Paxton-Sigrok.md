---
title: "Building a Sigrok Plugin to Decode Paxton RFID Readers"
layout: "post"
categories: ["Research"]
tags: ["Research","Paxton","Sigrok"]
typora-root-url: ./..
---

## Introduction

As part of an ongoing investigation into the Paxton Net2 access control system I wrote a sigrok protocol decoder to help me understand how the reader encoded the card data in the clock and data output.

You can download the [decoder plugin on github](https://github.com/en4rab/sigrok-paxton-pd)

## The Paxton RFID Reader

![Paxton reader](/assets/posts/2024-08-15-Paxton-Sigrok/paxton-reader.jpg)

Paxton RFID readers communicate with the Net2 door controllers using clock and data signalling. I wanted to understand how the card data from the reader was encoded to potentially enable the use of a Paxton reader as a tool to capture card numbers. Similar to the Bishop Fox [Tastic](https://resources.bishopfox.com/resources/tools/rfid-hacking/attack-tools/) 

![Keysight Scope Screenshot](/assets/posts/2024-08-15-Paxton-Sigrok/Scope.png)

Initially I didn't know what data came out of the readers so I looked first with an oscilloscope just to see what was happening then switching to a cheap Cypress FX2 based usb [logic analyser](https://sigrok.org/wiki/Hobby_Components_HCTEST0006) and [sigrock](https://sigrok.org/wiki/Main_Page) as that made analysing the signal easier.

## Clock and Data Vs Wiegand

The most common output from entry card readers is [Wiegand](https://en.wikipedia.org/wiki/Wiegand_interface) where there are two signal wires D0 (usually a green wire) and D1 (usually a white wire) where bits are represented by D0 being pulsed low for a 0 bit and D1 being pulsed low for a 1 bit.  
Sigrock has a decoder for this already as you can see in this image from the sigrok project.

![Sigrok wiegand decoder](/assets/posts/2024-08-15-Paxton-Sigrok/pv_wiegand.png)

Paxton readers can be configured to use wiegand but that is rather unlikely to be the case, normally they send their information using clock and data. This system uses the clock pin as timing and the value of the bit is read from the data line when the clock line is pulsed low. Below you can see a trace of a Paxton fob being scanned.

![Sigrok Pulseview Screenshot](/assets/posts/2024-08-15-Paxton-Sigrok/trace-small.png)

## Decoding the output

The reader outputs ten 1 bits as a lead in then 55 bits* of data and ten 1 bits as lead out. There was discussion on the proxmark3 discord around this time about decoding the data on paxton fobs. They worked out the fobs encoded the the number as a 4bit+odd parity, with this clue and some more searching I eventually found a [datasheet](/assets/posts/2024-08-15-Paxton-Sigrok/Ref_Pyramid_Series_Magnetic_Stripe_Data_Format.pdf) for a magstripe system from Farpointe that seemed to describe the data format exactly except for the bits being inverted i.e. the lead in and out were ten 0 bits. The Paxton system had originally been based on magstripe cards and it seems they kept this encoding method as they transitioned to using Hitag2 rfid tags instead.  
*It turns out that the number of bits varies between Net2 and Switch fobs and keypad presses.

![Magstripe data format](/assets/posts/2024-08-15-Paxton-Sigrok/magstripe-format.png)

At first I was decoding logic traces by hand but that gets old very very quickly so at this point I decided what I needed was a protocol decoder that would do all the hard work for me. 

## Automating the decoding

> This was very much a learning exercise for me so the code is not going to be elegant but it does work!  
{: .prompt-warning }

The sigrok project have a page on how to [get started writing a decoder](https://sigrok.org/wiki/Protocol_decoder_HOWTO) and the existing decoders source is available to help you understand how they work. Using some of these existing decoders as guides I managed to make a decoder. The outputs of this decoder bits/digits/card show the development stages where initially I just decoded the bits while I learnt how it all worked then I added parsing the bits and converting them to characters. It was at this point I discovered that scanning a switch fob rather than a net2 fob caused extra data to be output with 3 fields of data separated by a "D" so I added a third output with the numbers grouped as these fields.

 ![Paxton decoder working](/assets/posts/2024-08-15-Paxton-Sigrok/screenshot.png)

## Testing Keypads

Later a user on reddit asked about this protocol but specifically about keypads which I did not have access to and I suggested they try this decoder. It worked and it turns out key presses are encoded as CXXE where XX is the key number being pressed eg 01 02 03 and when the key is released the message is C99E. The user very kindly recorded a trace (keypad-all-keys.sr) for me which is in the samples directory of the repo.

![Keypad Key Pressed](/assets/posts/2024-08-15-Paxton-Sigrok/keypad-1-press.png) ![Keypad Key released](/assets/posts/2024-08-15-Paxton-Sigrok/keypad-1-release.png)

With the output now understood it should be possible to build a sniffer like the [ESPKey](https://github.com/octosavvi/ESPKey) or use a reader to sniff card numbers like the [BishopFox Tastic](https://resources.bishopfox.com/resources/tools/rfid-hacking/attack-tools/) 

## Download

If for some reason you find yourself messing with these readers you can download the [decoder plugin on github](https://github.com/en4rab/sigrok-paxton-pd)
