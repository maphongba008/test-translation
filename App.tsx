/** biome-ignore-all lint/suspicious/noAsyncPromiseExecutor: needed */
import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {Paths} from 'expo-file-system'
import { initTranslationsWorklet, translationsWorker } from './translations';

const path = `${Paths.document.uri}backend`.replace('file://', '')
const from = 'it'
const to = 'en'
const text = 'oggi è una bella giornata'

export default function App() {
  const [progress, setProgress] = useState(0)
  const [modelId, setModelId] = useState('')
  const [translatedText, setTranslatedText] = useState('')
  const start = async () => {
    await initTranslationsWorklet(path)
    const { code } = await translationsWorker.detectLanguage({ text: 'Ciao' })
    console.log('detected', code)
  
    const modelId = await new Promise(async (resolve) => {
      const stream = await translationsWorker.loadModel({ from, to })
      stream.on('data', (p) => {
        console.log(p)
        setProgress(p.progress.percentage)
        if (p.ready) {
          setModelId(p.modelId)
          resolve(p.modelId)
        }
      })
    })
    const translateResult = await translationsWorker.translate({modelId, modelType: 'nmt', from, to, text })
    console.log('translated', translateResult)
    setTranslatedText(translateResult.result)
    
  }
  return (
    <View style={styles.container}>
      <Text>Progress: {progress}</Text>
      <Text>ModelId: {modelId}</Text>
      <Text>{`Translated en -> it`} </Text>
      <Text>{`${text} -> ${translatedText}`} </Text>
      <StatusBar style="auto" />
      <TouchableOpacity style={{backgroundColor: 'green', padding: 20, marginTop: 20,}} onPress={start}>
        <Text style={{color: 'white'}}>Start</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingVertical: 100,
    paddingHorizontal: 20,
  },
});
