/** Hands a text file to the browser's download. The only place the Doctor touches the DOM to save something. */
export function downloadText(filename: string, text: string, mime: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: mime }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    // the download has started by the next task; releasing the URL sooner can cancel it in some browsers
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}
