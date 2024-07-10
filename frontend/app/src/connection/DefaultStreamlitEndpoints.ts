/**
 * Copyright (c) Streamlit Inc. (2018-2022) Snowflake Inc. (2022-2024)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import axios, { AxiosRequestConfig, AxiosResponse, CancelToken } from "axios"
import {
  BaseUriParts,
  buildHttpUri,
  StreamlitEndpoints,
  JWTHeader,
  getCookie,
  IAppPage,
} from "@streamlit/lib"

import { getDocument, GlobalWorkerOptions } from "pdfjs-dist"
import packageJson from "pdfjs-dist/package.json"

import { Document, Packer, Paragraph } from "docx"
import mammoth from "mammoth"

interface Props {
  getServerUri: () => BaseUriParts | undefined
  csrfEnabled: boolean
}

const MEDIA_ENDPOINT = "/media"
const UPLOAD_FILE_ENDPOINT = "/_stcore/upload_file"
const COMPONENT_ENDPOINT_BASE = "/component"
const FORWARD_MSG_CACHE_ENDPOINT = "/_stcore/message"

/** Default Streamlit server implementation of the StreamlitEndpoints interface. */
export class DefaultStreamlitEndpoints implements StreamlitEndpoints {
  private readonly getServerUri: () => BaseUriParts | undefined

  private readonly csrfEnabled: boolean

  private cachedServerUri?: BaseUriParts

  private jwtHeader?: JWTHeader

  public constructor(props: Props) {
    GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${packageJson.version}/pdf.worker.mjs`
    this.getServerUri = props.getServerUri
    this.csrfEnabled = props.csrfEnabled
  }

  public buildComponentURL(componentName: string, path: string): string {
    return buildHttpUri(
      this.requireServerUri(),
      `${COMPONENT_ENDPOINT_BASE}/${componentName}/${path}`
    )
  }

  public setJWTHeader(jwtHeader: JWTHeader): void {
    this.jwtHeader = jwtHeader
  }

  /**
   * Construct a URL for a media file. If the url is relative and starts with
   * "/media", assume it's being served from Streamlit and construct it
   * appropriately. Otherwise leave it alone.
   */
  public buildMediaURL(url: string): string {
    return url.startsWith(MEDIA_ENDPOINT)
      ? buildHttpUri(this.requireServerUri(), url)
      : url
  }

  /**
   * Construct a URL for uploading a file. If the URL is relative and starts
   * with "/_stcore/upload_file", assume we're uploading the file to the
   * Streamlit Tornado server and construct the URL appropriately. Otherwise,
   * we're probably uploading the file to some external service, so we leave
   * the URL alone.
   */
  public buildFileUploadURL(url: string): string {
    return url.startsWith(UPLOAD_FILE_ENDPOINT)
      ? buildHttpUri(this.requireServerUri(), url)
      : url
  }

  /** Construct a URL for an app page in a multi-page app. */
  public buildAppPageURL(
    pageLinkBaseURL: string | undefined,
    page: IAppPage
  ): string {
    const pageName = page.pageName as string
    const urlPath = page.urlPathname || pageName
    const navigateTo = page.isDefault ? "" : urlPath

    if (pageLinkBaseURL != null && pageLinkBaseURL.length > 0) {
      return `${pageLinkBaseURL}/${navigateTo}`
    }

    // NOTE: We use window.location to get the port instead of
    // getBaseUriParts() because the port may differ in dev mode (since
    // the frontend is served by the react dev server and not the
    // streamlit server).
    const { port, protocol } = window.location
    const { basePath, host } = this.requireServerUri()
    const portSection = port ? `:${port}` : ""
    const basePathSection = basePath ? `${basePath}/` : ""

    return `${protocol}//${host}${portSection}/${basePathSection}${navigateTo}`
  }

  public async uploadFileUploaderFile(
    fileUploadUrl: string,
    file: File,
    sessionId: string,
    onUploadProgress?: (progressEvent: any) => void,
    cancelToken?: CancelToken
  ): Promise<void> {
    const cleanedFile = await this.cleanFile(file)
    const form = new FormData()
    form.append(cleanedFile.name, cleanedFile)
    const headers: Record<string, string> = {}
    if (this.jwtHeader !== undefined) {
      headers[this.jwtHeader.jwtHeaderName] = this.jwtHeader.jwtHeaderValue
    }

    return this.csrfRequest<number>(this.buildFileUploadURL(fileUploadUrl), {
      cancelToken,
      method: "PUT",
      data: form,
      responseType: "text",
      headers,
      onUploadProgress,
    }).then(() => undefined) // If the request succeeds, we don't care about the response body
  }

  /**
   * Send an HTTP DELETE request to the given URL.
   */
  public async deleteFileAtURL(
    fileUrl: string,
    sessionId: string
  ): Promise<void> {
    return this.csrfRequest<number>(this.buildFileUploadURL(fileUrl), {
      method: "DELETE",
      data: { sessionId },
    }).then(() => undefined) // If the request succeeds, we don't care about the response body
  }

  public async fetchCachedForwardMsg(hash: string): Promise<Uint8Array> {
    const serverURI = this.requireServerUri()
    const rsp = await axios.request({
      url: buildHttpUri(
        serverURI,
        `${FORWARD_MSG_CACHE_ENDPOINT}?hash=${hash}`
      ),
      method: "GET",
      responseType: "arraybuffer",
    })

    return new Uint8Array(rsp.data)
  }

  /**
   * Fetch the server URI. If our server is disconnected, default to the most
   * recent cached value of the URI. If we're disconnected and have no cached
   * value, throw an Error.
   */
  private requireServerUri(): BaseUriParts {
    const serverUri = this.getServerUri()
    if (serverUri != null) {
      this.cachedServerUri = serverUri
      return serverUri
    }

    if (this.cachedServerUri != null) {
      return this.cachedServerUri
    }

    throw new Error("not connected to a server!")
  }

  /**
   * Wrapper around axios.request to update the request config with
   * CSRF headers if client has CSRF protection enabled.
   */
  private csrfRequest<T = any, R = AxiosResponse<T>>(
    url: string,
    params: AxiosRequestConfig
  ): Promise<R> {
    params.url = url

    if (this.csrfEnabled) {
      const xsrfCookie = getCookie("_streamlit_xsrf")
      if (xsrfCookie != null) {
        params.headers = {
          "X-Xsrftoken": xsrfCookie,
          ...(params.headers || {}),
        }
        params.withCredentials = true
      }
    }

    return axios.request<T, R>(params)
  }

  private async cleanFile(file: File): Promise<File> {
    try {
      const text = await this.extractLinesTextFormFile(file)

      if (!text) {
        throw new Error()
      }
      const typeResume = this.checkIsResumeFromMoex(text) ? "moex" : "hh"
      let cleanedText = ""
      if (typeResume === "moex") {
        const startIndexText = text.findIndex(line =>
          line.startsWith("Позиция")
        )
        cleanedText = text.slice(startIndexText).join("\n")
      } else if (typeResume === "hh") {
        const startIndexText = text.findIndex(
          line =>
            line === "Желаемая должность и зарплата" ||
            line === "Desired position and salary"
        )
        cleanedText = text.slice(startIndexText).join("\n")
      }
      return await this.generateDocx(cleanedText)
    } catch (error) {
      throw new Error(`Unsupported file type: ${file.type}`)
    }
  }

  private checkIsResumeFromMoex(lines: string[]): boolean {
    const sequence = ["Позиция", "Уровень", "Готов", "Локация"]
    let sequenceIndex = 0

    for (const line of lines) {
      if (line.startsWith(sequence[sequenceIndex])) {
        sequenceIndex++
        if (sequenceIndex === sequence.length) {
          return true
        }
      } else if (sequenceIndex > 0) {
        sequenceIndex = 0
        if (line.startsWith(sequence[sequenceIndex])) {
          sequenceIndex++
        }
      }
    }
    return false
  }

  private async extractLinesTextFormFile(
    file: File
  ): Promise<string[] | undefined> {
    const arrayBuffer = await file.arrayBuffer()
    const uint8Array = new Uint8Array(arrayBuffer)

    if (file.type === "application/pdf") {
      try {
        const pdfDocument = await getDocument(uint8Array).promise
        const numPages = pdfDocument.numPages

        const lines = []
        for (let i = 1; i <= numPages; i++) {
          const page = await pdfDocument.getPage(i)

          const textContent = await page.getTextContent()

          const pageLines: { y: number; text: string }[] = []

          textContent.items.forEach(item => {
            const { str, transform } = item as {
              str: string
              dir: string
              width: number
              height: number
              transform: number[]
              fontName: string
              hasEOL: boolean
            }
            const y = transform[5]

            const lastLine = pageLines[pageLines.length - 1]
            if (lastLine && Math.abs(lastLine.y - y) < 5) {
              lastLine.text += ` ${str}`
            } else {
              pageLines.push({ y, text: str })
            }
          })
          lines.push(
            ...pageLines.map(line => {
              return this.removeExtraSpaces(line.text)
            })
          )
          return lines
        }
      } catch (error) {
        console.error("Ошибка при обработке PDF:", error)
        throw error
      }
    } else if (
      file.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      let text = await this.readDocxContent(uint8Array)
      text = text.trim()
      const lines = text.replace(/\n+/g, "\n").split("\n")
      return lines
    }
  }

  private async generateDocx(text: string): Promise<File> {
    const doc = new Document({
      sections: [
        {
          properties: {},
          children: [new Paragraph(text)],
        },
      ],
    })

    const blob = await Packer.toBlob(doc)
    const file = new File([blob], "example.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })

    return file
  }

  private async readDocxContent(arrayBuffer: ArrayBuffer): Promise<string> {
    try {
      const result = await mammoth.extractRawText({ arrayBuffer })

      return result.value
    } catch (error) {
      throw new Error(
        "Failed to extract text from DOCX file: " + (error as Error).message
      )
    }
  }

  private removeExtraSpaces(text: string): string {
    return text.replace(/\s+/g, " ").trim()
  }
}
