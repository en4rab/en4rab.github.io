---
title: "Sniffiing the TPM to recover bitlocker VMK and FVEK keys"
layout: "post"
categories: ["Research"]
tags: ["Research","Bitlocker","TPM"]
---

# SPITkey  

## A tool to assist in recovery of bitlocker VMK and FVEK keys

While investigating the security of the various bitlocker configurations I wrote some scripts to assist in the analysis of logic analyser traces of SPI TPM traffic.  

> This was also a project to try to learn python so set your quality expectations accordingly.
{: .prompt-warning }

This could not have been done without the wealth of prior information about bitlocker that was already on the internet and I have included links to some of this in the References and Software section.

You can download it from Github here [SPITKey](https://github.com/en4rab/SPITkey)

This tool consists of several scripts:  

**logic2pcap.py sigrok2pcap.py swtpm2pcap**  
converts exported data from logic analyser to a pcap to view in wireshark can also export VMK/blob

**blob2john.py**  
converts encrypted blob to a format suitable for john the ripper or hashcat to try to break the pin

**SPITkey.py**  
Decrypt FVEK and Recovery key using VMK/blob/pin/BEK

## Capturing the data

| ![Logic2 Sniffing a key](/assets/posts/2024-07-22-Sniffing-Bitlocker-Keys/VMK-Logic2.png) |
|:--:|
| *Logic2 sniffing a key* |

The first step in sniffing the bitlocker key is to wire a logic analyser to the TPM chip and record the data during the boot process. 

| ![Wires soldered to TPM](/assets/posts/2024-07-22-Sniffing-Bitlocker-Keys/wiring.jpg) |
|:--:|
| *Obviously your soldering should be neater than this :P* |

SPI TPM's have a minimum bus speed of 10 - 24 MHz however the Trusted Computing Group encourage support for frequencies between 33MHz and 66MHz.
As a rule of thumb you ideally need a sample rate at least 4 times faster than the bus speed. e.g. a 43MHz Infineon 9670 would need an analyser than can sample 4 channels (MISO MOSI SCLK CS#) at a minimum of 172 MHz and if possible faster. With the data captured using the appropriate protocol decoders for your logic analyser (See [Plugins](#plugins)), export the trace to a CSV file so it can be processed with the SPITkey scripts.

## x2pcap.py

The scripts logic2pcap.py sigrok2pcap.py and swtpm2pcap.py will take the csv output from logic2, sigrok or the swtpm log and find the VMK (or encrypted VMK if in TPMandPIN mode) and save this out to a file. They will also optionally convert the data to pcaps (Wireshark is needed for this) so you can open the recorded data in Wireshark to analyse. This is not needed for key recovery but is very helpful if you are trying to understand TPM's and bitlocker in more detail. 

| ![Blob unsealed](/assets/posts/2024-07-22-Sniffing-Bitlocker-Keys/BLOB-pcap.png) |
|:--:|
| *In this image you can see the encrypted blob for TPMandPIN being unsealed.*|

| ![VMK unsealed](/assets/posts/2024-07-22-Sniffing-Bitlocker-Keys/VMK-pcap.png) |
|:--:|
| *This is what the TPM only VMK being unsealed looks like.* |

## Recovering the FVEK 

With the VMK (or encrypted VMK and known PIN) recovered from the logic analyser trace the bitlocker metadata can be read from the drive.  Connect the drive to a linux computer and run  

`dislocker -vvvv /dev/drive_dev > metadata.txt`

You can then use SPITKey.py, the VMK or encrypted VMK and pin and decrypt the FVEK (Full Volume Encryption Key) from this metadata. The FVEK is the key used do do the actual disk encryption and this will not change even if the protectors are changed, so it is almost a forever key. To change the FVEK you have to fully decrypt and then re-encrypt the drive. 

| ![SPITkey screenshot](/assets/posts/2024-07-22-Sniffing-Bitlocker-Keys/SPITKey.png) |
|:--:|
| *SPITkey decrypting TPMandPIN data* |

Once you have either the VMK or the FVEK you can use them with dislocker to mount the encrypted drive and decrypt it.

## Plugins

Plugins for analysing and extracting the VMK in TPMonly mode are available for both Logic2 and Pulseview.
I hope they will soon have support for finding and extracting the encrypted key blob in TPMandPIN mode too.  
**Logic2**  
WithSecureLabs, Tools for decoding TPM SPI transaction and extracting the BitLocker key from them.  
[https://github.com/WithSecureLabs/bitlocker-spi-toolkit](https://github.com/WithSecureLabs/bitlocker-spi-toolkit)  
**Pulseview**  
Ghecko, libsigrok stacked Protocol Decoder for TPM 2.0 & TPM 1.2 transactions from an SPI bus.  
[https://github.com/ghecko/libsigrokdecoder_spi-tpm](https://github.com/ghecko/libsigrokdecoder_spi-tpm)  


## References

Some links to excellent resources with more information on bitlocker:

Aurélien Bordes, 2011. Bitlocker  
[https://www.sstic.org/2011/presentation/bitlocker/](https://www.sstic.org/2011/presentation/bitlocker/)  
Elena Agostini, Massimo Bernaschi, 2019. BitCracker: BitLocker meets GPUs.  
[https://doi.org/10.48550/arXiv.1901.01337](https://doi.org/10.48550/arXiv.1901.01337)  
Jesse D. Kornblum, 2009. Implementing BitLocker Drive Encryption for Forensic Analysis.  
[https://sci-hub.st/https://doi.org/10.1016/j.diin.2009.01.001](https://sci-hub.st/https://doi.org/10.1016/j.diin.2009.01.001)  
Denis Andzakovic, 2019. Extracting BitLocker keys from a TPM.  
[https://pulsesecurity.co.nz/articles/TPM-sniffing](https://pulsesecurity.co.nz/articles/TPM-sniffing)  
Henri Nurmi, 2020. Sniff, there leaks my BitLocker key.  
[https://labs.withsecure.com/publications/sniff-there-leaks-my-bitlocker-key](https://labs.withsecure.com/publications/sniff-there-leaks-my-bitlocker-key)  

## Software

Aorimn, DisLocker - FUSE driver to read/write Windows BitLocker volumes under Linux/Mac OSX.  
[https://github.com/Aorimn/dislocker](https://github.com/Aorimn/dislocker)  
WithSecureLabs, Tools for decoding TPM SPI transaction and extracting the BitLocker key from them.  
[https://github.com/WithSecureLabs/bitlocker-spi-toolkit](https://github.com/WithSecureLabs/bitlocker-spi-toolkit)  
Ghecko, libsigrok stacked Protocol Decoder for TPM 2.0 & TPM 1.2 transactions from an SPI bus.  
[https://github.com/ghecko/libsigrokdecoder_spi-tpm](https://github.com/ghecko/libsigrokdecoder_spi-tpm)  
Libyal, Library and tools to access the BitLocker Drive Encryption (BDE) encrypted volumes  
[https://github.com/libyal/libbde](https://github.com/libyal/libbde)  

 
