/** biome-ignore-all lint/suspicious/noAsyncPromiseExecutor: needed */
import { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { reloadAppAsync } from 'expo'
import { StatusBar } from 'expo-status-bar';
import { Paths } from 'expo-file-system'

import { initTranslationsWorklet, translationsWorker } from './translations';

const path = `${Paths.document.uri}backend`.replace('file://', '')
const to = 'en'
const text = 'oggi è una bella giornata'

export default function App() {
  const [progress, setProgress] = useState(0)
  const [model, setModel] = useState()
  const [translatedText, setTranslatedText] = useState('')
  const [from, setFrom] = useState('')

  const start = async () => {
    console.log('start init')
    await initTranslationsWorklet(path)
    console.log('done init')

    const { code } = await translationsWorker.detectLanguage({ text })
    console.log('language detected', code)
    setFrom(code)

    const model = await new Promise(async (resolve) => {
      console.log('start load model')
      const stream = await translationsWorker.loadModel({ from: code, to })
      stream.on('data', (p) => {
        console.log('load model progress', p)
        setProgress(p.progress.percentage)
        if (p.ready) {
          console.log('model loaded', p)
          setModel(p)
          resolve(p)
        }
      })
    })

    const translateResult = await translationsWorker.translate({
      modelId: model.modelId,
      modelType: model.modelType,
      from,
      to,
      text
    })
    console.log('translated', translateResult)
    setTranslatedText(translateResult.result)

  }
  return (
    <View style={{
      flex: 1,
      backgroundColor: '#fff',
      paddingVertical: 100,
      paddingHorizontal: 20,
    }}>
      <Text>Progress: {progress}</Text>
      <Text>ModelId: {model?.modelId}</Text>
      <Text>{`Translated ${from} -> ${to}`} </Text>
      <Text>{`${text} -> ${translatedText}`} </Text>
      <StatusBar style="auto" />
      <TouchableOpacity style={{ backgroundColor: 'green', padding: 20, marginTop: 20, }} onPress={start}>
        <Text style={{ color: 'white' }}>Translate</Text>
      </TouchableOpacity>
      <TouchableOpacity style={{ backgroundColor: 'red', padding: 20, marginTop: 20, }} onPress={() => reloadAppAsync()}>
        <Text style={{ color: 'white' }}>Soft Reload</Text>
      </TouchableOpacity>
    </View>
  );
}

